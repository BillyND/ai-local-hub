package tunnel

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

var downloadMu sync.Mutex

const gitHubReleaseAPI = "https://api.github.com/repos/openai/tunnel-client/releases/latest"
const vendorPrefix = "https://github.com/openai/tunnel-client/releases/download/"

type asset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}
type release struct {
	Tag    string  `json:"tag_name"`
	Assets []asset `json:"assets"`
}
type manifest struct {
	Version        string `json:"version"`
	Platform       string `json:"platform"`
	Arch           string `json:"arch"`
	AssetName      string `json:"assetName"`
	ArchiveSHA256  string `json:"archiveSha256"`
	BinarySHA256   string `json:"binarySha256"`
	ExecutableName string `json:"executableName"`
}

func Hash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func Target() (string, string, string, error) {
	osName := runtime.GOOS
	arch := runtime.GOARCH
	if osName != "darwin" && osName != "linux" && osName != "windows" {
		return "", "", "", errors.New("unsupported tunnel OS")
	}
	if arch != "arm64" && arch != "amd64" {
		return "", "", "", errors.New("unsupported tunnel arch")
	}
	if osName == "windows" && arch == "arm64" {
		return "", "", "", errors.New("no Windows arm64 tunnel client")
	}
	exe := "tunnel-client"
	if osName == "windows" {
		exe += ".exe"
	}
	return osName, arch, exe, nil
}
func bounded(ctx context.Context, client *http.Client, link string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", link, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("download HTTP %d", res.StatusCode)
	}
	if res.ContentLength > limit {
		return nil, errors.New("asset exceeds download limit")
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("asset exceeds download limit")
	}
	return data, nil
}
func verify(dir string, want manifest) (string, bool) {
	path := filepath.Join(dir, "manifest.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	var got manifest
	if json.Unmarshal(data, &got) != nil || got.Version != want.Version || got.Platform != want.Platform || got.Arch != want.Arch || got.AssetName != want.AssetName || got.ExecutableName != want.ExecutableName {
		return "", false
	}
	bin := filepath.Join(dir, want.ExecutableName)
	b, err := os.ReadFile(bin)
	if err != nil || len(b) == 0 || Hash(b) != got.BinarySHA256 {
		return "", false
	}
	return bin, true
}
func extractZIP(data []byte, executable string) ([]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	for _, file := range reader.File {
		if filepath.Base(file.Name) != executable || file.FileInfo().IsDir() {
			continue
		}
		if file.UncompressedSize64 > 128<<20 {
			return nil, errors.New("tunnel binary exceeds 128 MiB")
		}
		f, err := file.Open()
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(io.LimitReader(f, 128<<20+1))
		_ = f.Close()
		if err != nil {
			return nil, err
		}
		if len(b) > 128<<20 {
			return nil, errors.New("tunnel binary exceeds 128 MiB")
		}
		return b, nil
	}
	return nil, errors.New("tunnel executable not in zip")
}
func Ensure(ctx context.Context, cache string) (string, error) {
	if explicit := os.Getenv("WORKSPACE_TOOLS_TUNNEL_BIN"); explicit != "" {
		s, err := os.Stat(explicit)
		if err != nil {
			return "", err
		}
		if !s.Mode().IsRegular() {
			return "", errors.New("tunnel binary path is not a file")
		}
		return explicit, nil
	}
	downloadMu.Lock()
	defer downloadMu.Unlock()
	osName, arch, exe, err := Target()
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 45 * time.Second}
	body, err := bounded(ctx, client, gitHubReleaseAPI, 1<<20)
	if err != nil {
		return "", err
	}
	var info release
	if err = json.Unmarshal(body, &info); err != nil {
		return "", err
	}
	if !regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$`).MatchString(info.Tag) {
		return "", errors.New("invalid tunnel release tag")
	}
	archive := fmt.Sprintf("tunnel-client-%s-%s-%s.zip", info.Tag, osName, arch)
	var sumsURL, archiveURL string
	for _, a := range info.Assets {
		if a.Name == "SHA256SUMS.txt" {
			sumsURL = a.URL
		}
		if a.Name == archive {
			archiveURL = a.URL
		}
	}
	if !strings.HasPrefix(sumsURL, vendorPrefix) || !strings.HasPrefix(archiveURL, vendorPrefix) {
		return "", errors.New("missing or untrusted vendor assets")
	}
	dir := filepath.Join(cache, "tunnel-client", info.Tag, osName+"-"+arch)
	wanted := manifest{Version: info.Tag, Platform: osName, Arch: arch, AssetName: archive, ExecutableName: exe}
	if p, ok := verify(dir, wanted); ok {
		return p, nil
	}
	sums, err := bounded(ctx, client, sumsURL, 1<<20)
	if err != nil {
		return "", err
	}
	expected := ""
	for _, line := range strings.Split(string(sums), "\n") {
		items := strings.Fields(line)
		if len(items) >= 2 && strings.TrimPrefix(items[1], "*") == archive {
			expected = items[0]
			break
		}
	}
	if len(expected) != 64 {
		return "", errors.New("archive SHA256 missing from official checksums")
	}
	zipData, err := bounded(ctx, client, archiveURL, 64<<20)
	if err != nil {
		return "", err
	}
	hash := Hash(zipData)
	if !strings.EqualFold(hash, expected) {
		return "", errors.New("official tunnel-client archive SHA256 mismatch")
	}
	binary, err := extractZIP(zipData, exe)
	if err != nil {
		return "", err
	}
	wanted.ArchiveSHA256 = hash
	wanted.BinarySHA256 = Hash(binary)
	if err = os.MkdirAll(filepath.Dir(dir), 0700); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(filepath.Dir(dir), ".stage-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	if err = os.WriteFile(filepath.Join(stage, exe), binary, 0755); err != nil {
		return "", err
	}
	raw, _ := json.MarshalIndent(wanted, "", "  ")
	if err = os.WriteFile(filepath.Join(stage, "manifest.json"), raw, 0600); err != nil {
		return "", err
	}
	if err = os.RemoveAll(dir); err != nil {
		return "", err
	}
	if err = os.Rename(stage, dir); err != nil {
		return "", err
	}
	return filepath.Join(dir, exe), nil
}
func safeEnv(key string) []string {
	names := []string{"HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "WINDIR", "PATHEXT", "ComSpec"}
	env := make([]string, 0, len(names)+1)
	for _, name := range names {
		if v, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+v)
		}
	}
	return append(env, "CONTROL_PLANE_API_KEY="+key)
}
func Connect(ctx context.Context, binary, dir, tunnelID, key, mcpURL string) (*exec.Cmd, error) {
	if key == "" || tunnelID == "" || binary == "" {
		return nil, errors.New("missing tunnel credentials")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	initCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	init := exec.CommandContext(initCtx, binary, "init", "--profile-dir", dir, "--profile", "ai-local-hub", "--sample", "sample_mcp_remote_no_auth", "--mcp-server-url", mcpURL, "--tunnel-id", tunnelID, "--health-listen-addr", "127.0.0.1:0", "--force")
	init.Env = safeEnv(key)
	if err := init.Run(); err != nil {
		return nil, fmt.Errorf("tunnel-client init failed: %w", err)
	}
	file := filepath.Join(dir, "health.url")
	run := exec.Command(binary, "run", "--profile-dir", dir, "--profile", "ai-local-hub", "--control-plane.api-key", "env:CONTROL_PLANE_API_KEY", "--health.listen-addr", "127.0.0.1:0", "--health.url-file", file)
	run.Env = safeEnv(key)
	if err := run.Start(); err != nil {
		return nil, err
	}
	stop := func() { _ = run.Process.Kill(); _, _ = run.Process.Wait() }
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	client := http.Client{Timeout: 1500 * time.Millisecond}
	for {
		select {
		case <-ctx.Done():
			stop()
			return nil, ctx.Err()
		case <-deadline.C:
			stop()
			return nil, errors.New("tunnel ready timeout")
		case <-ticker.C:
			b, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			base := strings.TrimRight(strings.TrimSpace(string(b)), "/")
			parsed, err := url.Parse(base)
			if err != nil || parsed.Scheme != "http" {
				continue
			}
			hostname := parsed.Hostname()
			if ip := net.ParseIP(hostname); hostname != "localhost" && (ip == nil || !ip.IsLoopback()) {
				continue
			}
			h, err := client.Get(base + "/healthz")
			if err != nil {
				continue
			}
			_ = h.Body.Close()
			if h.StatusCode/100 != 2 {
				continue
			}
			r, err := client.Get(base + "/readyz")
			if err != nil {
				continue
			}
			_ = r.Body.Close()
			if r.StatusCode/100 == 2 {
				return run, nil
			}
		}
	}
}
