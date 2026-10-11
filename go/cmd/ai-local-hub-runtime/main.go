package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/BillyND/ai-local-hub/go/internal/tunnel"
	"time"

	"github.com/BillyND/ai-local-hub/go/internal/worker"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func emit(kind string, fields map[string]any) {
	fields["type"] = kind
	b, _ := json.Marshal(fields)
	fmt.Println(string(b))
}
func main() {
	if err := run(); err != nil {
		emit("fatal", map[string]any{"message": err.Error()})
		os.Exit(1)
	}
}
func run() error {
	root := os.Getenv("WORKSPACE_ROOT")
	if root == "" {
		return errors.New("WORKSPACE_ROOT is required")
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	stat, err := os.Stat(root)
	if err != nil {
		return err
	}
	if !stat.IsDir() {
		return errors.New("workspace must be a directory")
	}
	// Never expose the runtime key to shell commands executed by the MCP tools.
	apiKey := os.Getenv("OPENAI_API_KEY")
	_ = os.Unsetenv("OPENAI_API_KEY")
	localOnly := false
	for _, arg := range os.Args[1:] {
		if arg == "--local-only" {
			localOnly = true
		}
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "ai-local-hub", Version: "0.1.0-go-dev"}, nil)
	worker.Register(server, root)
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{SessionTimeout: 15 * time.Minute, MaxRequestBodyBytes: 8 << 20})
	router := http.NewServeMux()
	router.Handle("/mcp", handler)
	router.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]bool{"ready": true})
	})
	router.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]bool{"ready": true})
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	secured := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if host != fmt.Sprintf("127.0.0.1:%d", port) && host != fmt.Sprintf("localhost:%d", port) {
			http.Error(w, "Forbidden host", 403)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+host {
			http.Error(w, "Forbidden origin", 403)
			return
		}
		router.ServeHTTP(w, r)
	})
	web := &http.Server{Handler: secured, ReadHeaderTimeout: 5 * time.Second}
	errs := make(chan error, 1)
	go func() { errs <- web.Serve(listener) }()
	url := fmt.Sprintf("http://127.0.0.1:%d/mcp", port)
	emit("log", map[string]any{"message": "Full filesystem/shell permissions enabled; workspace is not a sandbox"})
	emit("mcp", map[string]any{"url": url})
	emit("log", map[string]any{"message": "Tools: read, bash, edit, write, grep, find, ls"})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var tunnelExited <-chan error
	var tunnelProcess *exec.Cmd
	if !localOnly {
		cache := os.Getenv("WORKSPACE_TOOLS_CACHE_DIR")
		if cache == "" {
			cache = filepath.Join(os.TempDir(), "ai-local-hub-go-cache")
		}
		bin, err := tunnel.Ensure(ctx, cache)
		if err != nil {
			return fmt.Errorf("resolve official tunnel client: %w", err)
		}
		if err := os.MkdirAll(filepath.Join(cache, "runtime"), 0700); err != nil {
			return err
		}
		profile, err := os.MkdirTemp(filepath.Join(cache, "runtime"), "ai-local-hub-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(profile)
		emit("phase", map[string]any{"message": "Connecting tunnel"})
		tunnelProcess, err = tunnel.Connect(ctx, bin, profile, os.Getenv("OPENAI_TUNNEL_ID"), apiKey, url)
		if err != nil {
			return err
		}
		defer func() {
			if tunnelProcess.Process != nil {
				_ = tunnelProcess.Process.Kill()
			}
		}()
		done := make(chan error, 1)
		go func() { done <- tunnelProcess.Wait() }()
		tunnelExited = done
	}
	emit("ready", map[string]any{"tunnel": !localOnly})
	stdinDone := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); close(stdinDone) }()
	select {
	case <-ctx.Done():
	case <-stdinDone:
	case e := <-tunnelExited:
		if e != nil {
			return fmt.Errorf("tunnel-client exited: %w", e)
		}
		return errors.New("tunnel-client exited unexpectedly")
	case e := <-errs:
		if e != nil && !errors.Is(e, http.ErrServerClosed) {
			return e
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return web.Shutdown(shutdownCtx)
}
