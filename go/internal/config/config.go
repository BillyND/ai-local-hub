package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

type Instance struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	WorkspaceRoot string `json:"workspaceRoot"`
	TunnelID      string `json:"tunnelId"`
	APIKey        string `json:"apiKey"`
}
type Config struct {
	Version   int        `json:"version"`
	CacheDir  string     `json:"cacheDir"`
	Instances []Instance `json:"instances"`
}
type Input struct {
	Name          string `json:"name"`
	WorkspaceRoot string `json:"workspaceRoot"`
	TunnelID      string `json:"tunnelId"`
	APIKey        string `json:"apiKey"`
}

func Home() string { h, _ := os.UserHomeDir(); return h }
func Expand(p string) string {
	if p == "~" {
		return Home()
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(Home(), p[2:])
	}
	return p
}
func Path() string {
	if p := strings.TrimSpace(os.Getenv("WORKSPACE_TOOLS_CONFIG_FILE")); p != "" {
		return Expand(p)
	}
	return filepath.Join(Home(), ".config", "workspace-tools-mcp", "config.json")
}
func CacheDir(c Config) string {
	if p := strings.TrimSpace(os.Getenv("WORKSPACE_TOOLS_CACHE_DIR")); p != "" {
		return Expand(p)
	}
	return Expand(c.CacheDir)
}
func Defaults() Config {
	return Config{Version: 2, CacheDir: filepath.Join(Home(), ".cache", "workspace-tools-mcp"), Instances: []Instance{}}
}
func Load(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Defaults(), nil
	}
	if err != nil {
		return Config{}, err
	}
	var head struct {
		Version int `json:"version"`
	}
	if err = json.Unmarshal(b, &head); err != nil {
		return Config{}, fmt.Errorf("invalid saved JSON config: %w", err)
	}
	if head.Version == 1 {
		var old struct {
			WorkspaceRoot  string `json:"workspaceRoot"`
			OpenAITunnelID string `json:"openaiTunnelId"`
			OpenAIAPIKey   string `json:"openaiApiKey"`
			CacheDir       string `json:"cacheDir"`
		}
		if err := json.Unmarshal(b, &old); err != nil {
			return Config{}, err
		}
		if old.WorkspaceRoot == "" || old.CacheDir == "" {
			return Config{}, errors.New("invalid legacy config")
		}
		c := Config{Version: 2, CacheDir: old.CacheDir, Instances: []Instance{}}
		if old.OpenAITunnelID != "" && old.OpenAIAPIKey != "" {
			c.Instances = append(c.Instances, Instance{ID: "default", Name: "default", WorkspaceRoot: old.WorkspaceRoot, TunnelID: old.OpenAITunnelID, APIKey: old.OpenAIAPIKey})
		}
		return c, nil
	}
	if head.Version != 2 {
		return Config{}, fmt.Errorf("unsupported config version %d", head.Version)
	}
	c := Defaults()
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, err
	}
	if c.Instances == nil {
		c.Instances = []Instance{}
	}
	return c, nil
}
func Save(path string, c Config) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".ai-local-hub-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
func NewID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])[:8]
}
func Normalize(input Input, others []Instance, existingID string) (Instance, error) {
	name := strings.TrimSpace(input.Name)
	tunnel := strings.TrimSpace(input.TunnelID)
	key := strings.TrimSpace(input.APIKey)
	if name == "" || utf8.RuneCountInString(name) > 40 {
		return Instance{}, errors.New("name must be 1–40 characters")
	}
	if tunnel == "" {
		return Instance{}, errors.New("OpenAI Tunnel ID is required")
	}
	if key == "" {
		return Instance{}, errors.New("OpenAI API key is required")
	}
	for _, other := range others {
		if strings.EqualFold(other.Name, name) {
			return Instance{}, errors.New("instance name already exists")
		}
		if other.TunnelID == tunnel {
			return Instance{}, errors.New("Tunnel ID already used")
		}
	}
	folder := Expand(strings.TrimSpace(input.WorkspaceRoot))
	if folder == "" {
		return Instance{}, errors.New("workspace folder is required")
	}
	abs, err := filepath.Abs(folder)
	if err != nil {
		return Instance{}, err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return Instance{}, fmt.Errorf("workspace folder must exist: %w", err)
	}
	stat, err := os.Stat(resolved)
	if err != nil {
		return Instance{}, err
	}
	if !stat.IsDir() {
		return Instance{}, errors.New("workspace must be a directory")
	}
	if existingID == "" {
		existingID = NewID()
	}
	return Instance{ID: existingID, Name: name, WorkspaceRoot: resolved, TunnelID: tunnel, APIKey: key}, nil
}
