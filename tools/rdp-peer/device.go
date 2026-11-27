package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

const standbyProtocol = "cloudssh-rdp-device-v2"
const ping = "cloudssh-rdp-device-ping-v2"
const pong = "cloudssh-rdp-device-pong-v2"
const maxConfig = 8192
const machinePrefix = "/api/rdp/device/"

var hex64 = regexp.MustCompile(`^[a-f0-9]{64}$`)
var labelPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$`)
var credentialPattern = regexp.MustCompile(`^[!-~]{1,512}$`)
var tokenPattern = regexp.MustCompile(`^[a-zA-Z0-9.-]{100,280}$`)

type enrollment struct {
	Version        int    `json:"version"`
	Origin         string `json:"origin"`
	Grant          string `json:"grant"`
	Expires        int64  `json:"expires"`
	AccessRequired bool   `json:"accessRequired,omitempty"`
}

type accessCredentials struct {
	ID     string `json:"id,omitempty"`
	Secret string `json:"secret,omitempty"`
}

func (a accessCredentials) valid() bool {
	return (a.ID == "" && a.Secret == "") || (len(a.ID) <= 256 && credentialPattern.MatchString(a.ID) && credentialPattern.MatchString(a.Secret))
}

type identity struct {
	Version int               `json:"version"`
	Origin  string            `json:"origin"`
	Token   string            `json:"identity"`
	Private []byte            `json:"private"`
	Access  accessCredentials `json:"access"`
}

func validOrigin(origin string) bool {
	u, err := url.Parse(origin)
	return err == nil && len(origin) <= 300 && u.Scheme == "https" && u.Hostname() != "" && u.User == nil &&
		origin == "https://"+u.Host && !strings.ContainsAny(u.Host, "\\%\r\n\t ")
}
func isToken(s, prefix string) bool {
	return strings.HasPrefix(s, prefix+".") && tokenPattern.MatchString(s)
}
func parseEnrollment(raw []byte, now time.Time) (enrollment, error) {
	var e enrollment
	if len(raw) > maxConfig || json.Unmarshal(raw, &e) != nil || e.Version != 3 || !validOrigin(e.Origin) ||
		!isToken(e.Grant, "e3") || e.Expires <= now.UnixMilli() || e.Expires > now.Add(16*time.Minute).UnixMilli() {
		return enrollment{}, errors.New("invalid or expired installation authorization; download a fresh ZIP from CloudSSH")
	}
	return e, nil
}
func (id identity) valid() bool {
	return id.Version == 2 && validOrigin(id.Origin) && isToken(id.Token, "d2") && len(id.Private) == ed25519.PrivateKeySize && id.Access.valid()
}
func signature(key []byte, text string) string {
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(ed25519.PrivateKey(key), []byte(text)))
}
func clientForConnector() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func machineHeaders(token string, access accessCredentials) http.Header {
	h := http.Header{"Authorization": {"Bearer " + token}}
	if access.ID != "" {
		h.Set("CF-Access-Client-Id", access.ID)
		h.Set("CF-Access-Client-Secret", access.Secret)
	}
	return h
}

type machineStatus struct {
	action string
	code   int
}

func (e machineStatus) Error() string { return fmt.Sprintf("%s: HTTP %d", e.action, e.code) }

func requestMachine(ctx context.Context, client *http.Client, origin, action, token string, access accessCredentials, body any, out any) error {
	ctx, end := context.WithTimeout(ctx, 10*time.Second)
	defer end()
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+machinePrefix+action, bytes.NewReader(raw))
	if err != nil {
		return errors.New("invalid HTTPS endpoint")
	}
	req.Header = machineHeaders(token, access)
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%s: site unreachable (DNS, HTTPS or timeout)", action)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return machineStatus{action, res.StatusCode}
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxConfig+1))
	if err != nil || len(data) > maxConfig || json.Unmarshal(data, out) != nil {
		return fmt.Errorf("%s: invalid reply", action)
	}
	return nil
}

func register(ctx context.Context, client *http.Client, e enrollment, label string, a accessCredentials) (identity, string, error) {
	if !labelPattern.MatchString(label) {
		label = "Windows"
	}
	if !a.valid() {
		return identity{}, "", errors.New("invalid site Access Service Token")
	}
	pub, priv, err := ed25519.GenerateKey(cryptorand.Reader)
	if err != nil {
		return identity{}, "", errors.New("could not generate the device key")
	}
	public := base64.RawURLEncoding.EncodeToString(pub)
	fp := sha256.Sum256(pub)
	fingerprint := hex.EncodeToString(fp[:])
	var result struct {
		Identity    string `json:"identity"`
		Fingerprint string `json:"fingerprint"`
	}
	body := map[string]string{"key": public, "label": label, "signature": signature(priv, "cloudssh-rdp-register-v3\n"+e.Grant+"\n"+public+"\n"+label)}
	// Retry a lost or temporarily unavailable reply once with the SAME key; do not replay a rejected grant.
	for attempt := 0; ; attempt++ {
		result.Identity, result.Fingerprint = "", ""
		err := requestMachine(ctx, client, e.Origin, "register", e.Grant, a, body, &result)
		if err == nil {
			break
		}
		var status machineStatus
		if attempt > 0 || ctx.Err() != nil || (errors.As(err, &status) && status.code < 500) {
			clear(priv)
			return identity{}, "", err
		}
	}
	if !isToken(result.Identity, "d2") || result.Fingerprint != fingerprint {
		clear(priv)
		return identity{}, "", errors.New("invalid device registration reply")
	}
	return identity{Version: 2, Origin: e.Origin, Token: result.Identity, Private: priv, Access: a}, fingerprint, nil
}

func dialControl(ctx context.Context, client *http.Client, id identity, action, subprotocol, proof, sig string) (*websocket.Conn, error) {
	ctx, end := context.WithTimeout(ctx, 10*time.Second)
	defer end()
	headers := machineHeaders(id.Token, id.Access)
	headers.Set("X-RDP-Device-Proof", proof)
	if sig != "" {
		headers.Set("X-RDP-Device-Signature", sig)
	}
	ws, res, err := websocket.Dial(ctx, "wss"+id.Origin[5:]+machinePrefix+action,
		&websocket.DialOptions{HTTPHeader: headers, Subprotocols: []string{subprotocol}, HTTPClient: client})
	if err != nil {
		if res != nil {
			return nil, fmt.Errorf("%s: HTTP %d", action, res.StatusCode)
		}
		return nil, fmt.Errorf("%s: could not establish WSS", action)
	}
	if ws.Subprotocol() != subprotocol {
		ws.CloseNow()
		return nil, errors.New("wrong signaling protocol")
	}
	return ws, nil
}

type resident struct {
	client *http.Client
	id     identity
	ice    webrtc.Configuration
	dial   func(context.Context) (net.Conn, error)
	note   func(string)
}

func (r resident) loop(ctx context.Context) {
	backoff := time.Second
	var lastFailure string
	for ctx.Err() == nil {
		start := time.Now()
		err := r.listen(ctx)
		if ctx.Err() != nil {
			return
		}
		var rejected machineStatus
		if errors.As(err, &rejected) && rejected.action == "challenge" && rejected.code == http.StatusGone {
			r.note("Device identity was removed or enrollment expired. Uninstall and set up again.")
			<-ctx.Done() // Keep the service stoppable without polling a revoked binding.
			return
		}
		if time.Since(start) >= 20*time.Second {
			backoff = time.Second
			lastFailure = ""
		}
		if err != nil && err.Error() != lastFailure {
			lastFailure = err.Error()
			r.note("Connector waiting: " + lastFailure) // Only fixed local reasons or an HTTP status, never an address or secret.
		}
		wait := backoff + time.Duration(rand.Int64N(int64(backoff)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		backoff = min(12*time.Second, backoff*2)
	}
}

func (r resident) listen(parent context.Context) error {
	var c struct {
		Challenge string `json:"challenge"`
	}
	if err := requestMachine(parent, r.client, r.id.Origin, "challenge", r.id.Token, r.id.Access, struct{}{}, &c); err != nil {
		return err
	}
	if !hex64.MatchString(c.Challenge) {
		return errors.New("invalid challenge")
	}
	ws, err := dialControl(parent, r.client, r.id, "standby", standbyProtocol, c.Challenge,
		signature(r.id.Private, "cloudssh-rdp-standby-v2\n"+r.id.Token+"\n"+c.Challenge))
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	ws.SetReadLimit(256)
	ctx, stop := context.WithCancel(parent)
	var jobs sync.WaitGroup
	defer func() { stop(); jobs.Wait() }()
	var active atomic.Bool
	jobs.Add(1)
	go func() {
		defer jobs.Done()
		timer := time.NewTicker(15 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				short, end := context.WithTimeout(ctx, 4*time.Second)
				err := ws.Write(short, websocket.MessageText, []byte(ping))
				end()
				if err != nil {
					stop()
					return
				}
			}
		}
	}()
	r.note("Connector online")
	for {
		readCtx, end := context.WithTimeout(ctx, 42*time.Second)
		kind, raw, err := ws.Read(readCtx)
		end()
		if err != nil {
			return errors.New("standby disconnected")
		}
		if kind != websocket.MessageText {
			return errors.New("invalid standby message")
		}
		if string(raw) == pong {
			continue
		}
		var m struct {
			Type  string `json:"type"`
			Proof string `json:"proof"`
		}
		if json.Unmarshal(raw, &m) != nil || m.Type != "connect" || !hex64.MatchString(m.Proof) {
			return errors.New("invalid standby message")
		}
		if !active.CompareAndSwap(false, true) {
			continue
		}
		jobs.Add(1)
		go func(proof string) {
			defer jobs.Done()
			defer active.Store(false)
			peer, err := dialControl(ctx, r.client, r.id, "attach", protocol, proof, "")
			if err != nil {
				r.note("Desktop did not start (signaling_attach)")
				return
			}
			r.note("Desktop ended (" + desktopEndReason(run(ctx, peer, r.ice, r.dial, r.note)) + ")")
		}(m.Proof)
	}
}

// Use fixed reasons in Windows Event Log; never record network errors, SDP or device credentials.
func desktopEndReason(err error) string {
	if err == nil || errors.Is(err, context.Canceled) {
		return "closed"
	}
	switch err.Error() {
	case "control connection closed", "signaling closed":
		return "signaling_closed"
	case "ICE gathering timed out":
		return "ice_gather_timeout"
	case "direct connection lost":
		return "ice_or_dtls_disconnected"
	case "direct ICE pair required":
		return "no_direct_pair"
	case "cannot open local RDP":
		return "local_rdp_unavailable"
	case "desktop flow stalled":
		return "desktop_flow_stalled"
	case "lease expired", "invalid lease or system clock":
		return "lease_ended"
	default:
		return "peer_error"
	}
}

func productionResident(id identity, note func(string)) resident {
	return resident{client: clientForConnector(), id: id, note: note,
		ice: webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{
			"stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53",
		}}}},
		dial: func(ctx context.Context) (net.Conn, error) {
			return (&net.Dialer{Timeout: 4 * time.Second}).DialContext(ctx, "tcp4", localRDP)
		},
	}
}

func main() { platformMain() }
