// One owner-authorized desktop at a time. Windows sign-in stays in FreeRDP; the connector has no selectable TCP target.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

const protocol = "cloudssh-rdp-peer-v2"
const localRDP = "127.0.0.1:3389"
const frame = 16 * 1024
const window = 1024 * 1024

type control struct {
	Type  string `json:"type"`
	SDP   string `json:"sdp,omitempty"`
	Until int64  `json:"until,omitempty"`
}

func run(parent context.Context, ws *websocket.Conn, config webrtc.Configuration, dial func(context.Context) (net.Conn, error), note func(string)) error {
	ctx, cancel := context.WithCancelCause(parent)
	defer cancel(nil)
	defer ws.CloseNow()
	ws.SetReadLimit(14_000)
	fail := func(reason string) { cancel(errors.New(reason)) }
	signal := func(m control) bool {
		msg, _ := json.Marshal(m)
		deadline, stop := context.WithTimeout(ctx, 4*time.Second)
		defer stop()
		if ws.Write(deadline, websocket.MessageText, msg) != nil {
			fail("signaling closed")
			return false
		}
		return true
	}
	var expires atomic.Int64
	var authorized atomic.Bool
	started := time.Now()
	monotonicMS := func() int64 { return time.Since(started).Milliseconds() }
	expires.Store((8 * time.Second).Milliseconds())
	// Independent fail-closed deadline even when neither the browser nor Worker delivers a close frame.
	go func() {
		tick := time.NewTicker(250 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if monotonicMS() >= expires.Load() {
					fail("lease expired")
					return
				}
			}
		}
	}()
	var pc *webrtc.PeerConnection
	defer func() {
		if pc != nil {
			_ = pc.Close()
		}
	}()
	for ctx.Err() == nil {
		kind, b, err := ws.Read(ctx)
		if err != nil {
			if ctx.Err() == nil {
				fail("control connection closed")
			}
			break
		}
		var m control
		if kind != websocket.MessageText || json.Unmarshal(b, &m) != nil {
			fail("invalid signaling")
			break
		}
		switch m.Type {
		case "lease":
			now := time.Now().UnixMilli()
			if m.Until <= now || m.Until > now+45_000 {
				fail("invalid lease or system clock")
				break
			}
			// Validate the signed-in server's absolute deadline, then wait on a monotonic clock.
			expires.Store(monotonicMS() + min(m.Until-now, int64(35_000)))
			authorized.Store(true)
		case "offer":
			if !authorized.Load() || pc != nil || expires.Load() <= monotonicMS() || !validOffer(m.SDP) {
				fail("invalid offer")
				break
			}
			settings := webrtc.SettingEngine{}
			settings.SetSTUNGatherTimeout(3 * time.Second)
			settings.SetSCTPMaxReceiveBufferSize(window)
			logs := logging.NewDefaultLoggerFactory()
			logs.DefaultLogLevel = logging.LogLevelDisabled
			settings.LoggerFactory = logs
			p, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(config)
			if err != nil {
				fail("RTC unavailable")
				break
			}
			pc = p
			var taken atomic.Bool
			p.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
				if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateDisconnected {
					fail("direct connection lost")
				}
			})
			p.OnDataChannel(func(dc *webrtc.DataChannel) {
				if dc.Label() != protocol || !dc.Ordered() || dc.MaxRetransmits() != nil || dc.MaxPacketLifeTime() != nil || !taken.CompareAndSwap(false, true) {
					fail("invalid data channel")
					return
				}
				attachStream(ctx, dc, func() (net.Conn, error) {
					if expires.Load() <= monotonicMS() {
						return nil, errors.New("lease expired")
					}
					return dial(ctx)
				}, func() (string, string, bool) {
					pair, err := p.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
					if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil {
						return "", "", false
					}
					return pair.Local.Typ.String(), pair.Remote.Typ.String(), pair.Local.Typ != webrtc.ICECandidateTypeRelay && pair.Remote.Typ != webrtc.ICECandidateTypeRelay
				}, func() uint32 {
					return p.SCTP().Stats().CongestionWindow
				}, func() {
					signal(control{Type: "connected"})
					note("Direct data channel open to local RDP (no TURN or Worker desktop relay).")
				}, fail)
			})
			if p.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: m.SDP}) != nil {
				fail("offer rejected")
				break
			}
			answer, err := p.CreateAnswer(nil)
			if err != nil {
				fail("answer failed")
				break
			}
			gather := webrtc.GatheringCompletePromise(p)
			if p.SetLocalDescription(answer) != nil {
				fail("answer failed")
				break
			}
			select {
			case <-ctx.Done():
			case <-time.After(7 * time.Second):
				fail("ICE gathering timed out")
			case <-gather:
			}
			if ctx.Err() == nil {
				local := p.LocalDescription()
				if local == nil || !validOffer(local.SDP) {
					fail("invalid local answer")
					break
				}
				signal(control{Type: "answer", SDP: local.SDP})
			}
		default:
			fail("unexpected signaling")
		}
	}
	return context.Cause(ctx)
}

func validOffer(s string) bool {
	return len(s) <= 12_288 && strings.HasPrefix(s, "v=0\r\n") && strings.Count(s, "\nm=") == 1 && strings.Contains(s, "\nm=application ") && strings.Contains(s, " UDP/DTLS/SCTP webrtc-datachannel") && !strings.Contains(s, " typ relay") && strings.Contains(strings.ToLower(s), "a=fingerprint:sha-256 ")
}
