package ui

import (
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	configHome, err := os.MkdirTemp("", "ccs-go-ui-test-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "create temporary config home: %v\n", err)
		os.Exit(1)
	}
	if err := os.Setenv("XDG_CONFIG_HOME", configHome); err != nil {
		_ = os.RemoveAll(configHome)
		fmt.Fprintf(os.Stderr, "set temporary config home: %v\n", err)
		os.Exit(1)
	}

	code := m.Run()
	if err := os.RemoveAll(configHome); err != nil {
		fmt.Fprintf(os.Stderr, "remove temporary config home: %v\n", err)
		if code == 0 {
			code = 1
		}
	}
	os.Exit(code)
}
