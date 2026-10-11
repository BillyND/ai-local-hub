package manager

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BillyND/ai-local-hub/go/internal/config"
)

func fakeManager(t *testing.T) *Manager {
	t.Helper()
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(filepath.Join(t.TempDir(), "config.json"), bin, true)
	if err != nil {
		t.Fatal(err)
	}
	return m
}
func input(name, root string) config.Input {
	return config.Input{Name: name, WorkspaceRoot: root, TunnelID: "tunnel-" + name, APIKey: "secret-" + name}
}
func TestCRUDAndSecretPrivacy(t *testing.T) {
	m := fakeManager(t)
	root := t.TempDir()
	v, err := m.Create(input("hello", root))
	if err != nil {
		t.Fatal(err)
	}
	if !v.HasAPIKey || len(m.Views()) != 1 {
		t.Fatal(v)
	}
	raw, _ := json.Marshal(v)
	if string(raw) == "" || strings.Contains(string(raw), "secret-hello") {
		t.Fatal("api leaked secret")
	}
	if _, err = m.Create(input("HELLO", root)); err == nil {
		t.Fatal("duplicate permitted")
	}
	updated := input("renamed", root)
	updated.APIKey = ""
	v, err = m.Update(v.ID, updated)
	if err != nil || v.Name != "renamed" {
		t.Fatal(err, v)
	}
	data, err := config.Load(m.path)
	if err != nil || data.Instances[0].APIKey != "secret-hello" {
		t.Fatal("stored secret lost")
	}
	if err = m.Delete(v.ID); err != nil {
		t.Fatal(err)
	}
	if len(m.Views()) != 0 {
		t.Fatal("delete not reflected")
	}
}
func TestConcurrentCreateAndEvents(t *testing.T) {
	m := fakeManager(t)
	root := t.TempDir()
	ch, cancel := m.Subscribe()
	defer cancel()
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); _, err := m.Create(input(fmt.Sprintf("n%d", i), root)); errs <- err }(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(m.Views()) != 40 {
		t.Fatal("lost concurrent creations")
	}
	select {
	case msg := <-ch:
		if !strings.Contains(string(msg), `"type":"instances"`) {
			t.Fatal(string(msg))
		}
	case <-time.After(time.Second):
		t.Fatal("no SSE event broadcast")
	}
}
func TestFailedSaveDoesNotChangeState(t *testing.T) {
	m := fakeManager(t)
	root := t.TempDir()
	m.path = filepath.Join(root, "not-a-file")
	if err := os.Mkdir(m.path, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Create(input("safe", root)); err == nil {
		t.Fatal("expected persistence failure")
	}
	if len(m.Views()) != 0 {
		t.Fatal("memory mutated despite failed save")
	}
}
