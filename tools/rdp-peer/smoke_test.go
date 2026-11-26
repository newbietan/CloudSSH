package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
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

func TestEndpoint(t *testing.T) {
	for _, p := range []string{"http://example.com", "https://user@site.example/path", "https://site.example?code=123", "file:///tmp/a", "https://site.example/secret"} {
		if _, e := publicEndpoint(p); e == nil {
			t.Fatal("accepted non-origin")
		}
	}
	if got, e := publicEndpoint("https://site.example/"); e != nil || got != "wss://site.example/api/rdp/peer/agent" {
		t.Fatal("endpoint")
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
		_ = ws.Write(ctx, websocket.MessageText, []byte(`{"type":"waiting"}`))
		_ = ws.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"type":"lease","until":%d}`, time.Now().Add(500*time.Millisecond).UnixMilli())))
		_, _, _ = ws.Read(ctx)
	}))
	defer srv.Close()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	err = run(ctx, ws, webrtc.Configuration{}, func(context.Context) (net.Conn, error) { t.Fatal("pairing alone dialed RDP"); return nil, nil }, func(string) {})
	if err == nil || err.Error() != "lease expired" || ctx.Err() != nil {
		t.Fatal("expected independent lease expiry", err)
	}
}

// Only invoked by scripts/test-rdp-peer.mjs. Real Pion/DTLS/SCTP and loopback TCP, no public RDP or STUN.
// Only the TEST binary knows about the ephemeral CA and echo listener; neither is a connector option.
func TestBrowserInterop(t *testing.T) {
	site := os.Getenv("CLOUDSSH_PEER_TEST_SITE")
	if site == "" {
		t.Skip("opt-in browser interoperability")
	}
	u, e := url.Parse(site)
	if e != nil || u.Scheme != "https" || u.Hostname() != "127.0.0.1" {
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
	code, e := bufio.NewReader(io.LimitReader(os.Stdin, 300)).ReadString('\n')
	if e != nil {
		t.Fatal("no test code")
	}
	code = strings.TrimSpace(code)
	ctx, stop := context.WithTimeout(context.Background(), 65*time.Second)
	defer stop()
	endpoint, _ := publicEndpoint(site)
	ws, _, e := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + code}}, Subprotocols: []string{protocol}, HTTPClient: &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}}})
	if e != nil {
		t.Fatal("agent handshake:", e)
	}
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		c, err := listener.Accept()
		if err == nil {
			defer c.Close()
			if os.Getenv("CLOUDSSH_PEER_TEST_NATIVE") == "1" {
				// Read only the initial TPKT / X.224 connection request. Do not act as Windows or accept credentials.
				_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
				var h [6]byte
				if _, e := io.ReadFull(c, h[:]); e != nil || h[0] != 3 || h[1] != 0 || h[5] != 0xe0 || binary.BigEndian.Uint16(h[2:4]) < 11 {
					t.Error("no native X.224 connection request")
					return
				}
				fmt.Println("Native RDP negotiation reached loopback TCP.")
				return
			}
			_, _ = io.Copy(c, c)
		}
	}()
	err := run(ctx, ws, webrtc.Configuration{}, func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp4", listener.Addr().String())
	}, func(s string) { fmt.Println(s) })
	if ctx.Err() != nil || err == nil {
		t.Fatal("expected prompt session revocation")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("TCP not closed")
	}
}
