//go:build !windows

package main

import (
	"fmt"
	"os"
)

func platformMain() {
	fmt.Fprintln(os.Stderr, "CloudSSH RDP Connector installer runs on Windows.")
	os.Exit(2)
}
