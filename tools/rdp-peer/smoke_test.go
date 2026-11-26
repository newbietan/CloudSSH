package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

func TestEnrollmentOriginAndExpiry(t *testing.T) {
	for _, p := range []string{"http://example.com", "https://user@site.example", "https://site.example?code=123", "file:///tmp/a", "https://site.example/secret", "https://site.example#fragment"} {
		if validOrigin(p) {
			t.Fatal("accepted non-origin")
		}
	}
	const origin = "https://site.example:444"
	now := time.Now()
	f := enrollment{Version: 3, Origin: origin, Grant: "e3." + strings.Repeat("a", 180), Expires: now.Add(10 * time.Minute).UnixMilli()}
	b, _ := json.Marshal(f)
	if got, err := parseEnrollment(b, now); err != nil || got.Origin != origin {
		t.Fatal("valid site rejected", err)
	}
	if _, err := parseEnrollment(b, now.Add(11*time.Minute)); err == nil {
		t.Fatal("expired enrollment accepted")
	}
	f.Version, f.Grant = 2, "e2."+strings.Repeat("a", 180)
	old, _ := json.Marshal(f)
	if _, err := parseEnrollment(old, now); err == nil {
		t.Fatal("legacy manual-confirmation grant accepted")
	}
}

func TestRegisterRetryKeepsTheSameDeviceKey(t *testing.T) {
	body := make(chan string, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body <- string(raw)
		if len(body) == 1 {
			w.WriteHeader(503)
			return
		}
		var data map[string]string
		if json.Unmarshal(raw, &data) != nil {
			w.WriteHeader(400)
			return
		}
		pub, _ := base64.RawURLEncoding.DecodeString(data["key"])
		fp := sha256.Sum256(pub)
		_ = json.NewEncoder(w).Encode(map[string]string{"identity": "d2." + strings.Repeat("a", 140), "fingerprint": fmt.Sprintf("%x", fp)})
	}))
	defer srv.Close()
	e := enrollment{Version: 3, Origin: srv.URL, Grant: "e3." + strings.Repeat("a", 180)}
	id, _, err := register(context.Background(), clientForConnector(), e, "WINDOWS", accessCredentials{})
	defer clear(id.Private)
	if err != nil || len(body) != 2 || <-body != <-body {
		t.Fatal("temporary failure must retry once without changing the device key", err)
	}
}

func TestMachineDoesNotFollowRedirects(t *testing.T) {
	landed := make(chan struct{}, 1)
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { landed <- struct{}{} }))
	defer other.Close()
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer site.Close()
	var reply map[string]string
	err := requestMachine(context.Background(), clientForConnector(), site.URL, "register", "not-a-secret", accessCredentials{}, nil, &reply)
	if err == nil || err.Error() != "register: HTTP 307" {
		t.Fatal("expected bounded local error", err)
	}
	select {
	case <-landed:
		t.Fatal("cross-origin redirect followed")
	default:
	}
}

// Loss of control progress must stop a connector independently of browser/Worker timers.
func TestConnectorLeaseDeadline(t *testing.T) {
	ctx, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, e := websocket.Accept(w, r, nil)
		if e != nil {
			return
		}
		defer ws.CloseNow()
		_ = ws.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"type":"lease","until":%d}`, time.Now().Add(500*time.Millisecond).UnixMilli())))
		_, _, _ = ws.Read(ctx)
	}))
	defer srv.Close()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	err = run(ctx, ws, webrtc.Configuration{}, func(context.Context) (net.Conn, error) {
		t.Error("lease alone dialed RDP")
		return nil, fmt.Errorf("invalid")
	}, func(string) {})
	if err == nil || err.Error() != "lease expired" || ctx.Err() != nil {
		t.Fatal("expected independent lease expiry", err)
	}
}

// Only scripts/test-rdp-peer.mjs runs this real resident with hermetic TLS and TCP endpoints.
// The test binary alone accepts this temporary CA, RAM-scope test identity file and echo destination.
func TestBrowserInterop(t *testing.T) {
	site := os.Getenv("CLOUDSSH_PEER_TEST_SITE")
	if site == "" {
		t.Skip("opt-in browser interoperability")
	}
	u, e := url.Parse(site)
	if e != nil || !validOrigin(site) || u.Hostname() != "127.0.0.1" {
		t.Fatal("loopback HTTPS required")
	}
	pem, e := os.ReadFile(os.Getenv("CLOUDSSH_PEER_TEST_CA"))
	if e != nil {
		t.Fatal(e)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		t.Fatal("CA")
	}
	client := clientForConnector()
	client.Transport = &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	ctx, stop := context.WithTimeout(context.Background(), 180*time.Second)
	defer stop()
	identityFile := os.Getenv("CLOUDSSH_PEER_TEST_ID")
	if identityFile == "" {
		t.Fatal("missing private test path")
	}
	var id identity
	if raw, err := os.ReadFile(identityFile); err == nil {
		if json.Unmarshal(raw, &id) != nil || !id.valid() || id.Origin != site {
			t.Fatal("invalid test identity")
		}
	} else if os.IsNotExist(err) {
		raw, err := io.ReadAll(io.LimitReader(os.Stdin, maxConfig+1))
		if err != nil {
			t.Fatal("no enrollment")
		}
		f, err := parseEnrollment(raw, time.Now())
		if err != nil || f.Origin != site {
			t.Fatal("invalid enrollment")
		}
		var fingerprint string
		id, fingerprint, err = register(ctx, client, f, "Test-Windows", accessCredentials{})
		if err != nil {
			t.Fatal(err)
		}
		blob, _ := json.Marshal(id)
		if err := os.WriteFile(identityFile, blob, 0600); err != nil {
			t.Fatal(err)
		}
		fmt.Println("Device registered:", fingerprint)
	} else {
		t.Fatal("could not read test identity")
	}
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	go func() {
		for {
			c, err := listener.Accept()
			if err != nil {
				return
			}
			func() {
				defer func() { c.Close(); fmt.Println("Loopback TCP closed.") }()
				if os.Getenv("CLOUDSSH_PEER_TEST_NATIVE") == "1" {
					// Stop at the first TPKT/X.224 request, before credentials. This is not Windows.
					_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
					var h [6]byte
					if _, err := io.ReadFull(c, h[:]); err != nil || h[0] != 3 || h[1] != 0 || h[5] != 0xe0 || binary.BigEndian.Uint16(h[2:4]) < 11 {
						fmt.Println("Invalid native X.224 connection request")
						return
					}
					fmt.Println("Native RDP negotiation reached loopback TCP.")
					return
				}
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	resident{client: client, id: id, ice: webrtc.Configuration{}, dial: func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp4", listener.Addr().String())
	}, note: func(s string) { fmt.Println(s) }}.loop(ctx)
}
