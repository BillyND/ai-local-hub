package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/BillyND/ai-local-hub/go/internal/config"
	"github.com/BillyND/ai-local-hub/go/internal/manager"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "[go-dev]", err)
		os.Exit(1)
	}
}
func run() error {
	var localOnly, headless, noOpen, allowExisting, experimentalRemote bool
	var port int
	var worker, web string
	flag.BoolVar(&localOnly, "local-only", false, "run without OpenAI tunnel")
	flag.BoolVar(&experimentalRemote, "experimental-remote", false, "explicitly opt into UNVERIFIED Go tunnel integration; do not use production credentials")
	flag.BoolVar(&headless, "headless", false, "run saved instances without UI")
	flag.BoolVar(&noOpen, "no-open", false, "print URL without opening browser")
	flag.BoolVar(&allowExisting, "allow-existing-config", false, "explicitly permit the current production config; do not use for development")
	flag.IntVar(&port, "port", 0, "local manager port (0 chooses an unused port)")
	flag.StringVar(&worker, "worker", "", "path to Go worker binary")
	flag.StringVar(&web, "web", "", "path to prebuilt React UI")
	flag.Parse()
	if !localOnly && !experimentalRemote {
		return errors.New("Go remote tunnel E2E is unverified: use --local-only, or explicitly opt in with --experimental-remote")
	}
	if os.Getenv("WORKSPACE_TOOLS_CONFIG_FILE") == "" && !allowExisting {
		return errors.New("Go dev requires WORKSPACE_TOOLS_CONFIG_FILE pointing to an isolated config (production protection)")
	}
	if worker == "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		worker = filepath.Join(filepath.Dir(exe), "ai-local-hub-runtime")
	}
	if web == "" {
		web = os.Getenv("AI_LOCAL_HUB_WEB_DIR")
	}
	if web == "" {
		web = "dist/web"
	}
	m, err := manager.New(config.Path(), worker, localOnly)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if headless {
		for _, c := range m.Instances() {
			_ = m.Start(c.ID)
		}
		<-ctx.Done()
		m.Shutdown()
		return nil
	}
	var bytes [32]byte
	if _, err = rand.Read(bytes[:]); err != nil {
		return err
	}
	token := hex.EncodeToString(bytes[:])
	shutdown := make(chan struct{}, 1)
	handler := &manager.HTTP{Manager: m, Token: token, WebDir: web, Shutdown: shutdown}
	listener, err := manager.Listen(handler, port, port != 0)
	if err != nil {
		return err
	}
	defer listener.Close()
	base := fmt.Sprintf("http://127.0.0.1:%d/", handler.Port)
	link := base + "?token=" + token
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	fmt.Println("AI Local Hub Go development manager running.\nOpen: " + link)
	if !noOpen {
		opener := []string{"open", link}
		if runtime.GOOS == "windows" {
			opener = []string{"cmd", "/c", "start", link}
		} else if runtime.GOOS == "linux" {
			opener = []string{"xdg-open", link}
		}
		_ = exec.Command(opener[0], opener[1:]...).Start()
	}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(listener) }()
	select {
	case <-ctx.Done():
	case <-shutdown:
	case err = <-done:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	m.Shutdown()
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(c)
}

var _ = strings.TrimSpace
