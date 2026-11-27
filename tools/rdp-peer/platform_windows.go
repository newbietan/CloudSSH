package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
	"golang.org/x/term"
)

const serviceName = "CloudSSHRdpConnector"
const displayName = "CloudSSH RDP Connector"
const configFile = "identity.bin"
const installedExe = "connector.exe"
const bindingFile = "cloudssh-binding.cloudssh-rdp.json"

func platformMain() {
	service, err := svc.IsWindowsService()
	if err != nil {
		os.Exit(1)
	}
	if service {
		if len(os.Args) != 2 || os.Args[1] != "service" || svc.Run(serviceName, windowsService{}) != nil {
			os.Exit(1)
		}
		return
	}
	fmt.Println(displayName)
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "Run the installer without arguments to install, view status, or uninstall.")
		os.Exit(2)
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		exe, e := os.Executable()
		if e == nil {
			var path *uint16
			path, e = windows.UTF16PtrFromString(exe)
			if e == nil {
				e = windows.ShellExecute(0, wide("runas"), path, nil, nil, 1)
			}
		}
		if e == nil {
			return
		}
		fmt.Fprintln(os.Stderr, "Administrator approval is needed to install or remove the Windows service.")
		_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		return
	}
	in := bufio.NewReader(os.Stdin)
	if err := setup(in); err != nil {
		fmt.Fprintln(os.Stderr, "Setup did not complete:", err)
	}
	fmt.Print("Press Enter to close this installer. ")
	_, _ = in.ReadString('\n')
}

func directory() (string, error) {
	base, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil || !filepath.IsAbs(base) {
		return "", errors.New("Program Files is unavailable")
	}
	return filepath.Join(base, displayName), nil
}
func wide(s string) *uint16 { p, _ := windows.UTF16PtrFromString(s); return p }
func noReparse(path string, dir bool) error {
	attrs, err := windows.GetFileAttributes(wide(path))
	if err != nil {
		return err
	}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != dir {
		return errors.New("unexpected file type")
	}
	return nil
}
func readLimit(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("invalid file size")
	}
	return data, nil
}

// Machine-scope DPAPI lets a distinct service account decrypt the key; the protected file ACL
// restricts ciphertext access to this service SID, Administrators and SYSTEM. Not a hardware keystore.
func crypt(raw []byte, encrypt bool) ([]byte, error) {
	if len(raw) == 0 || len(raw) > maxConfig {
		return nil, errors.New("invalid device data")
	}
	in := windows.DataBlob{Size: uint32(len(raw)), Data: &raw[0]}
	var out windows.DataBlob
	var err error
	if encrypt {
		err = windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_LOCAL_MACHINE|windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	} else {
		err = windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	}
	if err != nil {
		return nil, errors.New("Windows DPAPI could not process the identity")
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(out.Data))))
	b := unsafe.Slice(out.Data, out.Size)
	defer clear(b)
	return append([]byte(nil), b...), nil
}
func readIdentity(dir string) (identity, error) {
	var id identity
	path := filepath.Join(dir, configFile)
	if noReparse(dir, true) != nil || noReparse(path, false) != nil {
		return id, errors.New("device identity file not found")
	}
	data, err := readLimit(path, maxConfig)
	if err != nil {
		return id, err
	}
	plain, err := crypt(data, false)
	if err != nil {
		return id, err
	}
	defer clear(plain)
	if json.Unmarshal(plain, &id) != nil || !id.valid() {
		return identity{}, errors.New("invalid device identity")
	}
	return id, nil
}
func writeIdentity(dir string, id identity) error {
	plain, err := json.Marshal(id)
	if err != nil {
		return err
	}
	defer clear(plain)
	blob, err := crypt(plain, true)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, configFile), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(blob)
	if err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

const adminDACL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

func protectedDirectory(folder string) error {
	sd, err := windows.SecurityDescriptorFromString(adminDACL)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	return windows.CreateDirectory(wide(folder), &sa)
}
func applyServiceACL(path string, sid *windows.SID, dir bool) error {
	if err := noReparse(path, dir); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(adminDACL + "(A;OICI;FRFX;;;" + sid.String() + ")")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}
func copyInstaller(dest string) error {
	path, err := os.Executable()
	if err != nil {
		return err
	}
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	const maxExe = 64 * 1024 * 1024
	n, err := io.Copy(dst, io.LimitReader(src, maxExe+1))
	closeErr := dst.Close()
	if err != nil || closeErr != nil || n == 0 || n > maxExe {
		return errors.New("could not copy the installer")
	}
	return nil
}

func installerBinding(exe string, now time.Time) (enrollment, error) {
	// UAC and shortcuts may change the current directory. Only the exact sibling of this EXE is used.
	path := filepath.Join(filepath.Dir(exe), bindingFile)
	if noReparse(path, false) != nil {
		return enrollment{}, errors.New("extract the entire CloudSSH setup ZIP, then run the installer from the extracted folder")
	}
	raw, err := readLimit(path, maxConfig)
	if err != nil {
		return enrollment{}, errors.New("could not read the adjacent CloudSSH installation authorization")
	}
	defer clear(raw)
	return parseEnrollment(raw, now)
}

func setup(in *bufio.Reader) error {
	dir, err := directory()
	if err != nil {
		return err
	}
	manager, err := mgr.Connect()
	if err != nil {
		return errors.New("cannot access the Windows Service Control Manager")
	}
	defer manager.Disconnect()
	existing, err := manager.OpenService(serviceName)
	if err == nil {
		defer existing.Close()
		return existingInstallation(in, dir, existing)
	}
	if !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return err
	}
	sourceExe, err := os.Executable()
	if err != nil {
		return errors.New("cannot determine the installer directory")
	}
	grant, err := installerBinding(sourceExe, time.Now())
	if err != nil {
		return err
	}
	fmt.Printf("CloudSSH site: %s\nThis PC will link automatically when its service comes online.\n", grant.Origin)
	var access accessCredentials
	if grant.AccessRequired {
		// Do not send separately entered Access secrets to a modified or unexpected binding-file origin.
		if !confirm(in, "Verify this site before entering its Access credentials. Continue? [y/N] ") {
			return nil
		}
		fmt.Print("Access Service Token Client ID: ")
		id, err := in.ReadString('\n')
		if err != nil {
			return errors.New("could not read Access Client ID")
		}
		fmt.Print("Access Service Token Client Secret (hidden): ")
		p, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return errors.New("could not read Access Client Secret")
		}
		access = accessCredentials{ID: strings.TrimSpace(id), Secret: strings.TrimSpace(string(p))}
		clear(p)
		if access.ID == "" || access.Secret == "" || !access.valid() {
			return errors.New("complete Access credentials are required")
		}
	}
	if err := protectedDirectory(dir); err != nil {
		return errors.New("installation directory already exists or cannot be created; remove an incomplete installation first")
	}
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(filepath.Join(dir, configFile))
			_ = os.Remove(filepath.Join(dir, installedExe))
			_ = os.Remove(dir)
		}
	}()
	exe := filepath.Join(dir, installedExe)
	if err := copyInstaller(exe); err != nil {
		return err
	}
	s, err := manager.CreateService(serviceName, exe, mgr.Config{
		DisplayName: displayName, Description: "CloudSSH device presence and owner-authorized WebRTC to local Remote Desktop.",
		StartType: mgr.StartAutomatic, DelayedAutoStart: true, ServiceStartName: `NT AUTHORITY\LocalService`,
		SidType: windows.SERVICE_SID_TYPE_UNRESTRICTED,
	}, "service")
	if err != nil {
		return err
	}
	logInstalled := false
	defer func() {
		if !ok {
			_ = s.Delete()
			if logInstalled {
				_ = eventlog.Remove(serviceName)
			}
		}
		_ = s.Close()
	}()
	sid, _, _, err := windows.LookupSID("", `NT SERVICE\`+serviceName)
	if err != nil {
		return errors.New("Windows could not resolve the connector service SID")
	}
	if err := applyServiceACL(dir, sid, true); err != nil {
		return errors.New("could not protect the installation directory")
	}
	if err := applyServiceACL(exe, sid, false); err != nil {
		return errors.New("could not grant the connector access to its executable")
	}
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 10 * time.Second}}, 86400); err != nil {
		return err
	}
	logInstalled = eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Info) == nil
	label, _ := os.Hostname()
	id, _, err := register(context.Background(), clientForConnector(), grant, label, access)
	if err != nil {
		return err
	}
	defer clear(id.Private)
	if err := writeIdentity(dir, id); err != nil {
		return err
	}
	if err := applyServiceACL(filepath.Join(dir, configFile), sid, false); err != nil {
		return errors.New("could not protect the device identity")
	}
	if err := s.Start(); err != nil {
		return err
	}
	ok = true
	fmt.Println("\nInstalled. The service links automatically as soon as it comes online. Return to CloudSSH and open the desktop.")
	return nil
}
func confirm(in *bufio.Reader, prompt string) bool {
	fmt.Print(prompt)
	v, err := in.ReadString('\n')
	return err == nil && strings.EqualFold(strings.TrimSpace(v), "y")
}
func existingInstallation(in *bufio.Reader, dir string, s *mgr.Service) error {
	status, err := s.Query()
	if err != nil {
		return err
	}
	if status.State == svc.Running {
		fmt.Println("Windows service is running.")
	} else {
		fmt.Println("Windows service is not running.")
	}
	if id, e := readIdentity(dir); e == nil {
		fp := sha256.Sum256(ed25519.PrivateKey(id.Private).Public().(ed25519.PublicKey))
		clear(id.Private)
		fmt.Printf("CloudSSH site: %s\nDevice-key SHA-256: %s\n", id.Origin, hex.EncodeToString(fp[:]))
	}
	if !confirm(in, "Uninstall the connector? Unlink this device in CloudSSH as well. [y/N] ") {
		return nil
	}
	if status.State != svc.Stopped {
		if status.State != svc.StopPending {
			if _, err := s.Control(svc.Stop); err != nil {
				return err
			}
		}
		for i := 0; i < 40; i++ {
			st, err := s.Query()
			if err != nil {
				return err
			}
			if st.State == svc.Stopped {
				break
			}
			if i == 39 {
				return errors.New("service did not stop")
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	if err := s.Delete(); err != nil {
		return err
	}
	_ = eventlog.Remove(serviceName)
	if err := noReparse(dir, true); err != nil {
		return errors.New("service removed; unexpected installation directory, no files deleted")
	}
	for _, name := range []string{configFile, installedExe} {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return errors.New("service removed; remove the remaining CloudSSH RDP Connector folder manually")
		}
	}
	_ = os.Remove(dir)
	fmt.Println("Uninstalled. Unlink the device in CloudSSH to revoke its server-side identity.")
	return nil
}

type windowsService struct{}

func (windowsService) Execute(_ []string, request <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	dir, err := directory()
	if err != nil {
		return false, 1
	}
	id, err := readIdentity(dir)
	if err != nil {
		return false, 1
	}
	defer clear(id.Private)
	log, _ := eventlog.Open(serviceName)
	if log != nil {
		defer log.Close()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		productionResident(id, func(s string) {
			if log != nil {
				_ = log.Info(1, s)
			}
		}).loop(ctx)
	}()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case <-done:
			return false, 1
		case req := <-request:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending, WaitHint: 12000}
				cancel()
				<-done
				return false, 0
			}
		}
	}
}
