package manager

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/BillyND/ai-local-hub/go/internal/config"
)

type Status struct {
	State       string `json:"state"`
	Phase       string `json:"phase,omitempty"`
	URL         string `json:"url,omitempty"`
	TunnelReady bool   `json:"tunnelReady"`
	Error       string `json:"error,omitempty"`
}

func stopped() Status { return Status{State: "stopped"} }

type View struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	WorkspaceRoot string `json:"workspaceRoot"`
	TunnelID      string `json:"tunnelId"`
	HasAPIKey     bool   `json:"hasApiKey"`
	Status        Status `json:"status"`
}
type entry struct {
	status     Status
	logs       []string
	stop       chan struct{}
	active     bool
	generation uint64
}
type Manager struct {
	mu        sync.Mutex
	data      config.Config
	path      string
	workerBin string
	localOnly bool
	entries   map[string]*entry
	listeners map[chan []byte]struct{}
	closed    bool
}

func New(path, workerBin string, localOnly bool) (*Manager, error) {
	c, err := config.Load(path)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(workerBin); err != nil {
		return nil, fmt.Errorf("Go worker executable: %w", err)
	}
	return &Manager{path: path, workerBin: workerBin, localOnly: localOnly, data: c, entries: map[string]*entry{}, listeners: map[chan []byte]struct{}{}}, nil
}
func (m *Manager) LocalOnly() bool { return m.localOnly }
func (m *Manager) listLocked() []View {
	list := make([]View, 0, len(m.data.Instances))
	for _, c := range m.data.Instances {
		list = append(list, m.viewLocked(c))
	}
	return list
}
func (m *Manager) viewLocked(c config.Instance) View {
	status := stopped()
	if e := m.entries[c.ID]; e != nil {
		status = e.status
	}
	return View{ID: c.ID, Name: c.Name, WorkspaceRoot: c.WorkspaceRoot, TunnelID: c.TunnelID, HasAPIKey: c.APIKey != "", Status: status}
}
func (m *Manager) Views() []View { m.mu.Lock(); defer m.mu.Unlock(); return m.listLocked() }
func (m *Manager) View(id string) (View, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.data.Instances {
		if c.ID == id {
			return m.viewLocked(c), true
		}
	}
	return View{}, false
}
func (m *Manager) lookupLocked(id string) (config.Instance, bool) {
	for _, c := range m.data.Instances {
		if c.ID == id {
			return c, true
		}
	}
	return config.Instance{}, false
}
func (m *Manager) emitLocked(msg any) {
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	for ch := range m.listeners {
		select {
		case ch <- b:
		default: /* a lagging client must never block the manager */
		}
	}
}
func (m *Manager) announceLocked() {
	m.emitLocked(map[string]any{"type": "instances", "instances": m.listLocked()})
}
func (m *Manager) statusLocked(id string, s Status) {
	e := m.entryLocked(id)
	e.status = s
	m.emitLocked(map[string]any{"type": "status", "id": id, "status": s})
}
func (m *Manager) entryLocked(id string) *entry {
	e := m.entries[id]
	if e == nil {
		e = &entry{status: stopped()}
		m.entries[id] = e
	}
	return e
}
func (m *Manager) Subscribe() (<-chan []byte, func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ch := make(chan []byte, 256)
	m.listeners[ch] = struct{}{}
	return ch, func() { m.mu.Lock(); defer m.mu.Unlock(); delete(m.listeners, ch); close(ch) }
}
func (m *Manager) Create(input config.Input) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	inst, err := config.Normalize(input, m.data.Instances, "")
	if err != nil {
		return View{}, err
	}
	next := m.data
	next.Instances = append(append([]config.Instance(nil), m.data.Instances...), inst)
	if err = config.Save(m.path, next); err != nil {
		return View{}, err
	}
	m.data = next
	m.announceLocked()
	return m.viewLocked(inst), nil
}
func (m *Manager) Update(id string, input config.Input) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old, found := m.lookupLocked(id)
	if !found {
		return View{}, os.ErrNotExist
	}
	if input.APIKey == "" {
		input.APIKey = old.APIKey
	}
	var others []config.Instance
	for _, inst := range m.data.Instances {
		if inst.ID != id {
			others = append(others, inst)
		}
	}
	updated, err := config.Normalize(input, others, id)
	if err != nil {
		return View{}, err
	}
	next := m.data
	next.Instances = append([]config.Instance(nil), m.data.Instances...)
	for i := range next.Instances {
		if next.Instances[i].ID == id {
			next.Instances[i] = updated
		}
	}
	if err = config.Save(m.path, next); err != nil {
		return View{}, err
	}
	m.data = next
	m.announceLocked()
	return m.viewLocked(updated), nil
}
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	_, found := m.lookupLocked(id)
	if !found {
		m.mu.Unlock()
		return os.ErrNotExist
	}
	next := m.data
	next.Instances = make([]config.Instance, 0, len(m.data.Instances)-1)
	for _, v := range m.data.Instances {
		if v.ID != id {
			next.Instances = append(next.Instances, v)
		}
	}
	if err := config.Save(m.path, next); err != nil {
		m.mu.Unlock()
		return err
	}
	m.data = next
	m.stopLocked(id)
	m.announceLocked()
	m.mu.Unlock()
	return nil
}
func (m *Manager) Logs(id string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.lookupLocked(id); !ok {
		return nil, os.ErrNotExist
	}
	e := m.entryLocked(id)
	return append([]string{}, e.logs...), nil
}
func (m *Manager) log(c config.Instance, line string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c.APIKey != "" {
		line = strings.ReplaceAll(line, c.APIKey, "[REDACTED]")
	}
	e := m.entryLocked(c.ID)
	e.logs = append(e.logs, line)
	if len(e.logs) > 1000 {
		e.logs = append([]string(nil), e.logs[len(e.logs)-1000:]...)
	}
	m.emitLocked(map[string]any{"type": "log", "id": c.ID, "line": line})
}
func (m *Manager) Start(id string) error {
	m.mu.Lock()
	c, ok := m.lookupLocked(id)
	if !ok {
		m.mu.Unlock()
		return os.ErrNotExist
	}
	e := m.entryLocked(id)
	if m.closed {
		m.mu.Unlock()
		return errors.New("manager is shutting down")
	}
	if e.active || e.stop != nil || e.status.State == "starting" || e.status.State == "running" || e.status.State == "stopping" {
		m.mu.Unlock()
		return nil
	}
	e.generation++
	gen := e.generation
	e.logs = []string{}
	m.statusLocked(id, Status{State: "starting", Phase: "Starting Go worker"})
	e.active = true
	e.stop = make(chan struct{})
	stop := e.stop
	m.mu.Unlock()
	go m.run(c, gen, stop)
	return nil
}
func (m *Manager) run(c config.Instance, gen uint64, stop <-chan struct{}) {
	cmd := exec.Command(m.workerBin)
	if m.localOnly {
		cmd.Args = append(cmd.Args, "--local-only")
	}
	cmd.Env = append(os.Environ(), "WORKSPACE_ROOT="+c.WorkspaceRoot, "OPENAI_TUNNEL_ID="+c.TunnelID, "OPENAI_API_KEY="+c.APIKey, "WORKSPACE_TOOLS_CACHE_DIR="+m.CacheDir())
	setProcessGroup(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		m.finish(c, gen, err)
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		m.finish(c, gen, err)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		m.finish(c, gen, err)
		return
	}
	if err = cmd.Start(); err != nil {
		m.finish(c, gen, err)
		return
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); m.scanWorker(c, gen, stdout, true) }()
	go func() { defer wg.Done(); m.scanWorker(c, gen, stderr, false) }()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	var waitErr error
	stoppedByRequest := false
	select {
	case waitErr = <-exited:
	case <-stop:
		stoppedByRequest = true
		_ = stdin.Close()
		select {
		case waitErr = <-exited:
		case <-time.After(5 * time.Second):
			killProcessGroup(cmd)
			waitErr = <-exited
		}
	}
	_ = stdin.Close()
	wg.Wait()
	if stoppedByRequest {
		waitErr = nil
	}
	m.finish(c, gen, waitErr)
}
func (m *Manager) finish(c config.Instance, gen uint64, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entryLocked(c.ID)
	if e.generation != gen {
		e.active = false
		e.stop = nil
		if e.status.State == "stopping" {
			m.statusLocked(c.ID, stopped())
		}
		return
	}
	e.stop = nil
	e.active = false
	if err != nil {
		msg := strings.ReplaceAll(err.Error(), c.APIKey, "[REDACTED]")
		m.statusLocked(c.ID, Status{State: "error", Error: msg})
	} else if e.status.State == "error" { /* preserve explicit worker fatal */
	} else {
		m.statusLocked(c.ID, stopped())
	}
}
func (m *Manager) scanWorker(c config.Instance, gen uint64, reader io.Reader, isStdout bool) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 32*1024), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !isStdout {
			m.log(c, line)
			continue
		}
		var msg struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			URL     string `json:"url"`
			Tunnel  bool   `json:"tunnel"`
		}
		if json.Unmarshal([]byte(line), &msg) != nil || msg.Type == "" {
			m.log(c, line)
			continue
		}
		switch msg.Type {
		case "log":
			m.log(c, msg.Message)
		case "fatal":
			m.mu.Lock()
			if e := m.entryLocked(c.ID); e.generation == gen {
				m.statusLocked(c.ID, Status{State: "error", Error: strings.ReplaceAll(msg.Message, c.APIKey, "[REDACTED]")})
			}
			m.mu.Unlock()
		case "mcp", "phase", "ready":
			m.mu.Lock()
			if e := m.entryLocked(c.ID); e.generation == gen {
				status := e.status
				if msg.Type == "mcp" {
					status.URL = msg.URL
				}
				if msg.Type == "phase" {
					status.Phase = msg.Message
				}
				if msg.Type == "ready" {
					status.State = "running"
					status.Phase = ""
					status.TunnelReady = msg.Tunnel
				}
				m.statusLocked(c.ID, status)
			}
			m.mu.Unlock()
		}
	}
	if err := scanner.Err(); err != nil {
		m.log(c, err.Error())
	}
}
func (m *Manager) stopLocked(id string) {
	e := m.entryLocked(id)
	if e.stop != nil {
		m.statusLocked(id, Status{State: "stopping", Phase: "Stopping Go worker"})
		select {
		case <-e.stop:
		default:
			close(e.stop)
		}
	} else if !e.active {
		m.statusLocked(id, stopped())
	}
}
func (m *Manager) Stop(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.lookupLocked(id); !ok {
		return os.ErrNotExist
	}
	m.stopLocked(id)
	return nil
}
func (m *Manager) StartAll() {
	for _, c := range m.Instances() {
		_ = m.Start(c.ID)
	}
}
func (m *Manager) StopAll() {
	for _, c := range m.Instances() {
		_ = m.Stop(c.ID)
	}
}
func (m *Manager) Instances() []config.Instance {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]config.Instance(nil), m.data.Instances...)
}
func (m *Manager) Shutdown() {
	m.mu.Lock()
	m.closed = true
	for id := range m.entries {
		m.stopLocked(id)
	}
	m.mu.Unlock()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		anyActive := false
		for _, e := range m.entries {
			anyActive = anyActive || e.active
		}
		m.mu.Unlock()
		if !anyActive {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}
func (m *Manager) CacheDir() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return filepath.Clean(config.CacheDir(m.data))
}
