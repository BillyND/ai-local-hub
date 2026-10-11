package manager

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/BillyND/ai-local-hub/go/internal/config"
)

type HTTP struct {
	Manager  *Manager
	Token    string
	Port     int
	WebDir   string
	Shutdown chan struct{}
}

func (h *HTTP) sendError(w http.ResponseWriter, status int, msg string) {
	respond(w, status, map[string]string{"error": msg})
}
func respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if data != nil {
		_ = json.NewEncoder(w).Encode(data)
	}
}
func (h *HTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.Host != fmt.Sprintf("127.0.0.1:%d", h.Port) && r.Host != fmt.Sprintf("localhost:%d", h.Port) {
		h.sendError(w, 403, "Forbidden host")
		return
	}
	if token := r.URL.Query().Get("token"); token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(h.Token)) == 1 {
		http.SetCookie(w, &http.Cookie{Name: "wtm_session", Value: h.Token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		query := r.URL.Query()
		query.Del("token")
		dest := r.URL.Path
		if q := query.Encode(); q != "" {
			dest += "?" + q
		}
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, dest, http.StatusFound)
		return
	}
	cookie, err := r.Cookie("wtm_session")
	if err != nil || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(h.Token)) != 1 {
		h.sendError(w, 401, "Not authorized. Open the link printed by AI Local Hub.")
		return
	}
	if r.Method == "POST" || r.Method == "PUT" || r.Method == "PATCH" || r.Method == "DELETE" {
		origin := r.Header.Get("Origin")
		if origin != fmt.Sprintf("http://127.0.0.1:%d", h.Port) && origin != fmt.Sprintf("http://localhost:%d", h.Port) {
			h.sendError(w, 403, "Cross-origin request blocked")
			return
		}
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		h.api(w, r)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		h.sendError(w, 405, "Method not allowed")
		return
	}
	h.static(w, r)
}
func decodeInput(r *http.Request) (config.Input, error) {
	defer r.Body.Close()
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return config.Input{}, errors.New("Content-Type must be application/json")
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 64*1024+1))
	if err != nil {
		return config.Input{}, err
	}
	if len(data) > 64*1024 {
		return config.Input{}, errors.New("JSON request too large")
	}
	var input config.Input
	if err = json.Unmarshal(data, &input); err != nil {
		return input, err
	}
	return input, nil
}
func (h *HTTP) api(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/")
	parts := strings.Split(path, "/")
	kind := parts[0]
	id := ""
	action := ""
	if len(parts) > 1 {
		id = parts[1]
	}
	if len(parts) > 2 {
		action = parts[2]
	}
	m := h.Manager
	switch {
	case r.Method == "GET" && kind == "state" && id == "":
		respond(w, 200, map[string]any{"instances": m.Views(), "localOnly": m.LocalOnly(), "homeDir": config.Home(), "version": "0.1.0-go-dev"})
		return
	case r.Method == "GET" && kind == "events" && id == "":
		h.events(w, r)
		return
	case r.Method == "GET" && kind == "fs" && id == "":
		h.fs(w, r)
		return
	case r.Method == "POST" && kind == "instances" && id == "":
		input, err := decodeInput(r)
		if err != nil {
			h.sendError(w, 400, err.Error())
			return
		}
		v, err := m.Create(input)
		if err != nil {
			h.sendError(w, 400, err.Error())
			return
		}
		respond(w, 201, v)
		return
	case kind == "instances" && id != "":
		if _, ok := m.View(id); !ok {
			h.sendError(w, 404, "Instance not found")
			return
		}
		switch {
		case r.Method == "PUT" && action == "":
			input, err := decodeInput(r)
			if err != nil {
				h.sendError(w, 400, err.Error())
				return
			}
			v, err := m.Update(id, input)
			if err != nil {
				h.sendError(w, 400, err.Error())
				return
			}
			respond(w, 200, v)
			return
		case r.Method == "DELETE" && action == "":
			if err := m.Delete(id); err != nil {
				h.sendError(w, 500, err.Error())
				return
			}
			w.WriteHeader(204)
			return
		case r.Method == "GET" && action == "logs":
			lines, _ := m.Logs(id)
			respond(w, 200, map[string]any{"lines": lines})
			return
		case r.Method == "POST" && action == "start":
			if err := m.Start(id); err != nil {
				h.sendError(w, 500, err.Error())
				return
			}
			v, _ := m.View(id)
			respond(w, 200, v)
			return
		case r.Method == "POST" && action == "stop":
			if err := m.Stop(id); err != nil {
				h.sendError(w, 500, err.Error())
				return
			}
			v, _ := m.View(id)
			respond(w, 200, v)
			return
		}
	case r.Method == "POST" && kind == "start-all" && id == "":
		m.StartAll()
		w.WriteHeader(204)
		return
	case r.Method == "POST" && kind == "stop-all" && id == "":
		m.StopAll()
		w.WriteHeader(204)
		return
	case r.Method == "POST" && kind == "shutdown" && id == "":
		select {
		case h.Shutdown <- struct{}{}:
		default:
		}
		respond(w, 202, map[string]bool{"ok": true})
		return
	}
	h.sendError(w, 404, "Not found")
}
func (h *HTTP) events(w http.ResponseWriter, r *http.Request) {
	f, ok := w.(http.Flusher)
	if !ok {
		h.sendError(w, 500, "Streaming unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ch, closeFn := h.Manager.Subscribe()
	defer closeFn()
	_, _ = fmt.Fprint(w, ": connected\n\n")
	f.Flush()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case v, ok := <-ch:
			if !ok {
				return
			}
			_, _ = fmt.Fprintf(w, "data: %s\n\n", v)
			f.Flush()
		case <-ping.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			f.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
func (h *HTTP) fs(w http.ResponseWriter, r *http.Request) {
	requested := r.URL.Query().Get("path")
	if requested == "" {
		requested = config.Home()
	}
	if !filepath.IsAbs(requested) {
		h.sendError(w, 400, "Path must be absolute")
		return
	}
	items, err := os.ReadDir(requested)
	if err != nil {
		h.sendError(w, 400, err.Error())
		return
	}
	names := make([]string, 0)
	for _, item := range items {
		if !strings.HasPrefix(item.Name(), ".") {
			p := filepath.Join(requested, item.Name())
			stat, e := os.Stat(p)
			if e == nil && stat.IsDir() {
				names = append(names, item.Name())
			}
		}
	}
	sort.Strings(names)
	if len(names) > 1000 {
		names = names[:1000]
	}
	resolved, err := filepath.EvalSymlinks(requested)
	if err != nil {
		resolved = requested
	}
	parent := any(nil)
	if next := filepath.Dir(resolved); next != resolved {
		parent = next
	}
	respond(w, 200, map[string]any{"path": resolved, "parent": parent, "dirs": names})
}
func (h *HTTP) static(w http.ResponseWriter, r *http.Request) {
	path, err := url.PathUnescape(r.URL.Path)
	if err != nil || strings.Contains(path, "\\") || strings.Contains(path, "\x00") {
		http.NotFound(w, r)
		return
	}
	segments := strings.Split(path, "/")
	for _, s := range segments {
		if s == ".." {
			http.NotFound(w, r)
			return
		}
	}
	rel := strings.TrimPrefix(path, "/")
	if rel == "" {
		rel = "index.html"
	}
	candidate := filepath.Join(h.WebDir, rel)
	info, err := os.Stat(candidate)
	if err != nil || !info.Mode().IsRegular() {
		if filepath.Ext(rel) != "" {
			http.NotFound(w, r)
			return
		}
		candidate = filepath.Join(h.WebDir, "index.html")
	}
	root, err := filepath.EvalSymlinks(h.WebDir)
	if err != nil {
		http.Error(w, "UI assets not found", 503)
		return
	}
	actual, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	relative, err := filepath.Rel(root, actual)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}
	if strings.Contains(relative, string(filepath.Separator)+"assets"+string(filepath.Separator)) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	http.ServeFile(w, r, actual)
}
func Listen(h *HTTP, port int, strict bool) (net.Listener, error) {
	listen := func(p int) (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p)) }
	l, err := listen(port)
	if err != nil && !strict {
		l, err = listen(0)
	}
	if err != nil {
		return nil, err
	}
	h.Port = l.Addr().(*net.TCPAddr).Port
	return l, nil
}
