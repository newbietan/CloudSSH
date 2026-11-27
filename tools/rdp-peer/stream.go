package main

import (
	"context"
	"encoding/json"
	"net"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// Pion's BufferedAmount includes unacknowledged SCTP data, not just the unsent queue.
// Keep a full congestion window fed, but allow only two extra frames of read-ahead.
func desktopSendBudget(cwnd uint32) uint64 {
	return min(uint64(window), uint64(cwnd)+2*frame)
}

// TLS/NLA stays in FreeRDP. Binary messages are an ordered byte stream, not disposable video frames.
// The browser ACKs WASM reads (not JS delivery). Keep that credit independent of SCTP's send budget.
func attachStream(ctx context.Context, dc *webrtc.DataChannel, dial func() (net.Conn, error), selected func() (string, string, bool), congestionWindow func() uint32, connected func(), fail func(string)) {
	var mu sync.Mutex
	var tcp net.Conn
	var sent, ack, received uint64
	wake := make(chan struct{}, 1)
	writable := func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	dc.OnBufferedAmountLow(writable)
	reserveReadCredit := func(bytes uint64) bool {
		mu.Lock()
		defer mu.Unlock()
		if sent-ack+bytes > window {
			return false
		}
		sent += bytes
		return true
	}
	reserve := func(bytes uint64) bool {
		var timeout <-chan time.Time
		for ctx.Err() == nil {
			limit := desktopSendBudget(congestionWindow()) - bytes // At least two frames before reserving.
			if dc.BufferedAmount() <= limit && reserveReadCredit(bytes) {
				return true
			}
			dc.SetBufferedAmountLowThreshold(limit)
			// Recheck after installing the threshold: the buffer or read credit may have changed.
			if dc.BufferedAmount() <= limit && reserveReadCredit(bytes) {
				return true
			}
			if timeout == nil {
				timer := time.NewTimer(25 * time.Second)
				defer timer.Stop()
				timeout = timer.C
			}
			select {
			case <-wake:
			case <-ctx.Done():
				return false
			case <-timeout:
				fail("desktop flow stalled")
				return false
			}
		}
		return false
	}
	writeControl := func(m any) bool {
		b, _ := json.Marshal(m)
		if ctx.Err() != nil || dc.BufferedAmount() > window+frame || dc.SendText(string(b)) != nil {
			fail("data channel stalled")
			return false
		}
		return true
	}
	dc.OnClose(func() { fail("data channel closed") })
	dc.OnError(func(error) { fail("data channel failed") })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if ctx.Err() != nil {
			return
		}
		mu.Lock()
		c := tcp
		mu.Unlock()
		if c == nil {
			fail("premature data")
			return
		}
		if m.IsString {
			var v struct {
				Type  string  `json:"type"`
				Bytes *uint64 `json:"bytes"`
				ID    int     `json:"id"`
			}
			if len(m.Data) > 160 || json.Unmarshal(m.Data, &v) != nil {
				fail("invalid data control")
				return
			}
			switch v.Type {
			case "ack":
				mu.Lock()
				ok := v.Bytes != nil && *v.Bytes >= ack && *v.Bytes <= sent
				if ok {
					ack = *v.Bytes
				}
				mu.Unlock()
				if !ok {
					fail("invalid credit")
					return
				}
				writable()
			case "ping":
				if v.ID < 1 || v.ID > 0x7fffffff {
					fail("invalid probe")
					return
				}
				writeControl(map[string]any{"type": "pong", "id": v.ID})
			default:
				fail("unexpected data control")
			}
			return
		}
		if len(m.Data) == 0 || len(m.Data) > frame {
			fail("invalid binary frame")
			return
		}
		_ = c.SetWriteDeadline(time.Now().Add(8 * time.Second))
		n, err := c.Write(m.Data)
		if err != nil || n != len(m.Data) {
			fail("local RDP write failed")
			return
		}
		// Pion invokes OnMessage sequentially for this single ordered channel.
		received += uint64(n)
		writeControl(map[string]any{"type": "ack", "bytes": received})
	})
	dc.OnOpen(func() {
		local, remote, ok := selected()
		if !ok {
			fail("direct ICE pair required")
			return
		}
		c, err := dial()
		if err != nil {
			fail("cannot open local RDP")
			return
		}
		defer c.Close()
		stop := context.AfterFunc(ctx, func() { _ = c.Close() })
		defer stop()
		if ctx.Err() != nil {
			return
		}
		mu.Lock()
		tcp = c
		mu.Unlock()
		connected()
		if !writeControl(map[string]any{"type": "direct_ready", "local": local, "remote": remote}) {
			return
		}
		buf := make([]byte, frame)
		for ctx.Err() == nil {
			n, err := c.Read(buf)
			if n > 0 {
				if !reserve(uint64(n)) {
					return
				}
				if dc.BufferedAmount() > window+frame || dc.Send(buf[:n]) != nil {
					fail("data channel write failed")
					return
				}
			}
			if err != nil {
				fail("local RDP closed")
				return
			}
		}
	})
}
