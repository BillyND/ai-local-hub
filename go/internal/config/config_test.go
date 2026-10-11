package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLegacyMigrationPreservesCredentials(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	old := `{"version":1,"workspaceRoot":"` + dir + `","cacheDir":"` + dir + `/cache","openaiTunnelId":"tunnel","openaiApiKey":"secret-test"}`
	if err := os.WriteFile(path, []byte(old), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.Version != 2 || len(c.Instances) != 1 || c.Instances[0].APIKey != "secret-test" || c.Instances[0].ID != "default" {
		t.Fatalf("legacy migration lost data: %+v", c)
	}
	if err = Save(path, c); err != nil {
		t.Fatal(err)
	}
	stat, _ := os.Stat(path)
	if stat.Mode().Perm() != 0600 {
		t.Fatalf("saved permissions: %s", stat.Mode())
	}
}
func TestAtomicSaveOnError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	c := Defaults()
	if err := Save(path, c); err != nil {
		t.Fatal(err)
	}
	// A directory at the target path rejects replacement and preserves the original contents.
	blocker := filepath.Join(dir, "dir")
	if err := os.Mkdir(blocker, 0700); err != nil {
		t.Fatal(err)
	}
	if err := Save(blocker, c); err == nil {
		t.Fatal("expected save failure")
	}
	if _, err := Load(path); err != nil {
		t.Fatal(err)
	}
}
func TestNormalize(t *testing.T) {
	dir := t.TempDir()
	one, err := Normalize(Input{Name: " One ", WorkspaceRoot: dir, TunnelID: "abc", APIKey: "key"}, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	resolvedDir, _ := filepath.EvalSymlinks(dir)
	if one.Name != "One" || one.WorkspaceRoot != resolvedDir {
		t.Fatal(one)
	}
	if _, err := Normalize(Input{Name: "one", WorkspaceRoot: dir, TunnelID: "def", APIKey: "key"}, []Instance{one}, ""); err == nil {
		t.Fatal("duplicate allowed")
	}
	if _, err := Normalize(Input{Name: "Two", WorkspaceRoot: dir, TunnelID: "abc", APIKey: "key"}, []Instance{one}, ""); err == nil {
		t.Fatal("duplicate tunnel allowed")
	}
	if _, err := Normalize(Input{Name: "Two", WorkspaceRoot: "/not-here-" + strings.Repeat("x", 12), TunnelID: "def", APIKey: "key"}, nil, ""); err == nil {
		t.Fatal("missing workspace allowed")
	}
}
