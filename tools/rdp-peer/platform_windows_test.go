package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestWindowsDPAPI(t *testing.T) {
	p := []byte("temporary fixture; not a key")
	enc, err := crypt(p, true)
	if err != nil || len(enc) == 0 || bytes.Contains(enc, p) {
		t.Fatal("DPAPI protection", err)
	}
	dec, err := crypt(enc, false)
	if err != nil || !bytes.Equal(p, dec) {
		t.Fatal("DPAPI recovery", err)
	}
}

func TestAdjacentInstallationAuthorization(t *testing.T) {
	dir := t.TempDir()
	const exe = "cloudssh-rdp-connector-windows-amd64.exe"
	now := time.Now()
	grant := enrollment{Version: 3, Origin: "https://desk.example", Grant: "e3." + strings.Repeat("a", 180), Expires: now.Add(time.Minute).UnixMilli()}
	blob, _ := json.Marshal(grant)
	if _, err := installerBinding(filepath.Join(dir, exe), now); err == nil {
		t.Fatal("accepted a partial extraction")
	}
	if err := os.WriteFile(filepath.Join(dir, bindingFile), blob, 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := installerBinding(filepath.Join(dir, exe), now); err != nil || got != grant {
		t.Fatal("expected exact sibling", err)
	}
	if _, err := installerBinding(filepath.Join(t.TempDir(), exe), now); err == nil {
		t.Fatal("used a different directory")
	}
	if _, err := installerBinding(filepath.Join(dir, exe), now.Add(2*time.Minute)); err == nil {
		t.Fatal("accepted expired authorization")
	}
}

// CI's clean Windows VM only. It exercises the real binary and LocalService token, with no credentials or Windows desktop.
func TestWindowsSCMLifecycle(t *testing.T) {
	if os.Getenv("CLOUDSSH_WINDOWS_SCM_TEST") != "1" {
		t.Skip("explicit Windows VM SCM test")
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Fatal("SCM test must run elevated on the disposable CI VM")
	}
	dir, err := directory()
	if err != nil {
		t.Fatal(err)
	}
	manager, err := mgr.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Disconnect()
	if prev, err := manager.OpenService(serviceName); err == nil {
		prev.Close()
		t.Fatal("refusing to modify an existing installation")
	} else if !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		t.Fatal(err)
	}
	if err := protectedDirectory(dir); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(dir)
	exe := filepath.Join(dir, installedExe)
	defer os.Remove(exe)
	if out, err := exec.Command("go", "build", "-mod=readonly", "-o", exe, ".").CombinedOutput(); err != nil {
		t.Fatalf("service build: %v %s", err, out)
	}
	s, err := manager.CreateService(serviceName, exe, mgr.Config{StartType: mgr.StartAutomatic,
		DelayedAutoStart: true, ServiceStartName: `NT AUTHORITY\LocalService`, SidType: windows.SERVICE_SID_TYPE_UNRESTRICTED}, "service")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	defer s.Delete()
	sid, _, _, err := windows.LookupSID("", `NT SERVICE\`+serviceName)
	if err != nil {
		t.Fatal(err)
	}
	if err := applyServiceACL(dir, sid, true); err != nil {
		t.Fatal(err)
	}
	if err := applyServiceACL(exe, sid, false); err != nil {
		t.Fatal(err)
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(key)
	p := filepath.Join(dir, configFile)
	defer os.Remove(p)
	if err := writeIdentity(dir, identity{Version: 2, Origin: "https://127.0.0.1:65534", Token: "d2." + strings.Repeat("a", 144), Private: key}); err != nil {
		t.Fatal(err)
	}
	if err := applyServiceACL(p, sid, false); err != nil {
		t.Fatal(err)
	}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Control(svc.Stop)
	awaitState := func(expected svc.State) {
		for i := 0; i < 40; i++ {
			state, err := s.Query()
			if err != nil {
				t.Fatal(err)
			}
			if state.State == expected {
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
		t.Fatalf("SCM state %v not reached", expected)
	}
	awaitState(svc.Running)
	if _, err := s.Control(svc.Stop); err != nil {
		t.Fatal(err)
	}
	awaitState(svc.Stopped)
	if err := s.Start(); err != nil {
		t.Fatal(err)
	} // Identity remains decryptable by a new LocalService process.
	awaitState(svc.Running)
	if _, err := s.Control(svc.Stop); err != nil {
		t.Fatal(err)
	}
	awaitState(svc.Stopped)
}
