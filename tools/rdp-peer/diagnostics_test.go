package main

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestProductionSTUNAllowsTheOfficialAlternatePortWithoutTURN(t *testing.T) {
	r := productionResident(identity{}, func(string) {})
	want := []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"}}}
	if !reflect.DeepEqual(r.ice.ICEServers, want) {
		t.Fatal("production must use the fixed primary and alternate STUN ports only")
	}
}

func TestConnectorDiagnosticsExposeOnlyFixedReasons(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{nil, "closed"},
		{context.Canceled, "closed"},
		{errors.New("cannot open local RDP"), "local_rdp_unavailable"},
		{errors.New("control connection closed"), "signaling_closed"},
		{errors.New("direct connection lost"), "ice_or_dtls_disconnected"},
		{errors.New("synthetic private network detail"), "peer_error"},
	} {
		if got := desktopEndReason(tc.err); got != tc.want {
			t.Errorf("reason = %s; expected %s", got, tc.want)
		}
	}
}
