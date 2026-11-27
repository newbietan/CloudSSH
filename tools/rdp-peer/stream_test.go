package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

func TestDesktopSendBudget(t *testing.T) {
	for _, tc := range []struct {
		cwnd uint32
		want uint64
	}{
		{0, 2 * frame}, // Also safe before SCTP has a sample.
		{4096, 2*frame + 4096},
		{256 * 1024, 288 * 1024},
		{window - frame, window},
		{^uint32(0), window},
	} {
		if got := desktopSendBudget(tc.cwnd); got != tc.want {
			t.Fatalf("cwnd=%d: budget=%d, want %d", tc.cwnd, got, tc.want)
		}
	}
}

// The opt-in comparison below runs actual SCTP and keeps all packets on loopback.
// The limiter schedules (rather than blocking) UDP writes so the sender can build a queue.
type pacedDatagram struct {
	payload []byte
	target  netip.AddrPort
	at      time.Time
}

type pacedUDP struct {
	*net.UDPConn
	mu       sync.Mutex
	queue    chan pacedDatagram
	closed   chan struct{}
	once     sync.Once
	next     time.Time
	latency  time.Duration
	byteRate int
}

func newPacedUDP(t *testing.T, latency time.Duration, byteRate int) *pacedUDP {
	t.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	p := &pacedUDP{UDPConn: conn, latency: latency, byteRate: byteRate,
		queue: make(chan pacedDatagram, 1536), closed: make(chan struct{})}
	t.Cleanup(func() { _ = p.Close() })
	go p.forward()
	return p
}

func (p *pacedUDP) Close() error {
	p.once.Do(func() { close(p.closed) })
	return p.UDPConn.Close()
}

func (p *pacedUDP) WriteTo(payload []byte, target net.Addr) (int, error) {
	addr, ok := target.(*net.UDPAddr)
	if !ok || !addr.IP.IsLoopback() {
		return 0, errors.New("test shaper permits loopback UDP only")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if now := time.Now(); p.next.Before(now) {
		p.next = now
	}
	if p.byteRate > 0 {
		p.next = p.next.Add(time.Second * time.Duration(len(payload)+28) / time.Duration(p.byteRate))
	}
	select {
	case <-p.closed:
		return 0, net.ErrClosed
	case p.queue <- pacedDatagram{bytes.Clone(payload), addr.AddrPort(), p.next.Add(p.latency)}:
		return len(payload), nil
	default:
		return 0, errors.New("test shaper queue exceeded")
	}
}

func (p *pacedUDP) forward() {
	for {
		select {
		case <-p.closed:
			return
		case packet := <-p.queue:
			if wait := time.Until(packet.at); wait > 0 {
				timer := time.NewTimer(wait)
				select {
				case <-timer.C:
				case <-p.closed:
					timer.Stop()
					return
				}
			}
			if _, err := p.UDPConn.WriteToUDPAddrPort(packet.payload, packet.target); err != nil {
				return
			}
		}
	}
}

func shapedPeer(t *testing.T, latency time.Duration, byteRate int) *webrtc.PeerConnection {
	t.Helper()
	logs := logging.NewDefaultLoggerFactory()
	logs.DefaultLogLevel = logging.LogLevelDisabled
	settings := webrtc.SettingEngine{LoggerFactory: logs}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetSCTPMaxReceiveBufferSize(window)
	mux := webrtc.NewICEUDPMux(logs.NewLogger("shaper"), newPacedUDP(t, latency, byteRate))
	t.Cleanup(func() { _ = mux.Close() })
	settings.SetICEUDPMux(mux)
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	return pc
}

func gatherTestSDP(ctx context.Context, t *testing.T, pc *webrtc.PeerConnection, sdp webrtc.SessionDescription) webrtc.SessionDescription {
	t.Helper()
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(sdp); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
		return *pc.LocalDescription()
	case <-ctx.Done():
		t.Fatal(context.Cause(ctx))
		return webrtc.SessionDescription{}
	}
}

type interactionResult struct {
	echo, total time.Duration
	buffered    uint64
}

func measureInteraction(t *testing.T, downRate int, oneWay time.Duration, tuned bool) interactionResult {
	t.Helper()
	const records = 128 // 2 MiB of continuous synthetic screen output, plus a reply.
	const reply = ^uint32(0)
	ctx, cancel := context.WithTimeoutCause(context.Background(), 24*time.Second, errors.New("interaction fixture timed out"))
	defer cancel()
	ctx, stop := context.WithCancelCause(ctx)
	defer stop(nil)
	fail := func(reason string) { stop(errors.New(reason)) }
	browser, connector := shapedPeer(t, oneWay, 0), shapedPeer(t, oneWay, downRate)
	local, app := net.Pipe() // No synthetic OS queue: the fixture prioritizes a reply on its next write.
	defer local.Close()
	defer app.Close()
	var sending atomic.Pointer[webrtc.DataChannel]
	connector.OnDataChannel(func(dc *webrtc.DataChannel) {
		sending.Store(dc)
		attachStream(ctx, dc, func() (net.Conn, error) { return local, nil },
			func() (string, string, bool) { return "host", "host", true }, func() uint32 {
				if !tuned {
					return window // Old full read-ahead under the same application credit and SCTP path.
				}
				return connector.SCTP().Stats().CongestionWindow
			}, func() {}, fail)
	})
	input := make(chan uint64, 1)
	go func() {
		var key [1]byte
		if _, err := io.ReadFull(app, key[:]); err == nil && key[0] == 0x35 {
			input <- sending.Load().BufferedAmount()
		}
	}()
	start := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-start:
		}
		buf := bytes.Repeat([]byte{0x5a}, frame)
		responded := false
		for seq := uint32(0); seq < records; seq++ {
			if !responded && len(input) != 0 {
				binary.LittleEndian.PutUint32(buf, reply)
				if _, err := app.Write(buf); err != nil {
					return
				}
				responded = true
			}
			binary.LittleEndian.PutUint32(buf, seq)
			if _, err := app.Write(buf); err != nil {
				return
			}
		}
	}()
	dc, err := browser.CreateDataChannel(protocol, nil)
	if err != nil {
		t.Fatal(err)
	}
	var began, actionAt time.Time
	var echo time.Duration
	var seq uint32
	var consumed, lastAck int
	finished := make(chan interactionResult, 1)
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		now := time.Now()
		if m.IsString {
			if began.IsZero() {
				began = now
				close(start)
			}
			return
		}
		if len(m.Data) != frame || began.IsZero() || !bytes.Equal(m.Data[4:], bytes.Repeat([]byte{0x5a}, frame-4)) {
			fail("fixture corrupted bytes")
			return
		}
		if id := binary.LittleEndian.Uint32(m.Data); id == reply && echo == 0 && !actionAt.IsZero() {
			echo = now.Sub(actionAt)
		} else if id == seq && seq < records {
			seq++
		} else {
			fail("fixture reordered bytes")
			return
		}
		consumed += len(m.Data)
		if seq == 4 && actionAt.IsZero() {
			actionAt = time.Now()
			if dc.Send([]byte{0x35}) != nil {
				fail("fixture input failed")
				return
			}
		}
		if consumed-lastAck >= 2*frame || seq == records {
			if dc.SendText(fmt.Sprintf(`{"type":"ack","bytes":%d}`, consumed)) != nil {
				fail("fixture ACK failed")
				return
			}
			lastAck = consumed
		}
		if seq == records {
			if echo == 0 || len(input) == 0 {
				fail("fixture did not receive input echo during transfer")
				return
			}
			finished <- interactionResult{echo, now.Sub(began), <-input}
		}
	})
	offer, err := browser.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := connector.SetRemoteDescription(gatherTestSDP(ctx, t, browser, offer)); err != nil {
		t.Fatal(err)
	}
	answer, err := connector.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := browser.SetRemoteDescription(gatherTestSDP(ctx, t, connector, answer)); err != nil {
		t.Fatal(err)
	}
	select {
	case data := <-finished:
		return data
	case <-ctx.Done():
		t.Fatal(context.Cause(ctx))
		return interactionResult{}
	}
}

func TestLimitedDesktopInteraction(t *testing.T) {
	if os.Getenv("CLOUDSSH_RDP_LATENCY_TEST") != "1" {
		t.Skip("opt-in, wall-clock loopback bandwidth comparison")
	}
	for _, profile := range []struct {
		name string
		rate int
		lag  time.Duration
	}{
		{"limited", 500_000, 35 * time.Millisecond},
		{"fast", 5_000_000, 14 * time.Millisecond},
	} {
		t.Run(profile.name, func(t *testing.T) {
			old := measureInteraction(t, profile.rate, profile.lag, false)
			tuned := measureInteraction(t, profile.rate, profile.lag, true)
			minimum := 2 * 1024 * 1024 * time.Second / time.Duration(profile.rate)
			if old.total < minimum || tuned.total < minimum {
				t.Fatal("desktop traffic bypassed the test bandwidth limit")
			}
			t.Logf("%.1f Mbit/s, base RTT %v | echo %v -> %v | queued+unconfirmed at input %.0f -> %.0f KiB | transfer %v -> %v",
				float64(profile.rate)*8/1e6, 2*profile.lag, old.echo.Round(time.Millisecond), tuned.echo.Round(time.Millisecond),
				float64(old.buffered)/1024, float64(tuned.buffered)/1024, old.total.Round(time.Millisecond), tuned.total.Round(time.Millisecond))
			if profile.name == "limited" && (tuned.echo >= old.echo || tuned.buffered >= old.buffered) {
				t.Fatal("tuned flow did not reduce the synthetic input queue")
			}
			if tuned.total > old.total*5/4 {
				t.Fatal("tuned flow starved bulk transfer")
			}
		})
	}
}
