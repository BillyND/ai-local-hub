package worker

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestBoundedUnicode(t *testing.T) {
	in := strings.Repeat("a", 49999) + "😀" + strings.Repeat("Z", 100)
	s := bounded(in)
	if !utf8.ValidString(s) || !strings.Contains(s, "[Output truncated") {
		t.Fatal("truncation corrupted UTF-8")
	}
}
func TestFilenameMatching(t *testing.T) {
	if !matchesGlob("*.go", "src/test.go") {
		t.Fatal("basic extension glob")
	}
	if !matchesGlob("**/*.go", "internal/src/test.go") {
		t.Fatal("recursive extension glob")
	}
	if matchesGlob("*.tsx", "README.md") {
		t.Fatal("wrong glob matched")
	}
}
func TestShellTimeoutAndSecretScrub(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture shell command is Unix-specific")
	}
	root := t.TempDir()
	old, had := os.LookupEnv("OPENAI_API_KEY")
	os.Unsetenv("OPENAI_API_KEY")
	defer func() {
		if had {
			os.Setenv("OPENAI_API_KEY", old)
		}
	}()
	r, err := runShell(root)(context.Background(), BashArgs{Command: "sleep 2", Timeout: 0.1})
	if err != nil || !r.IsError || r.StructuredContent == nil {
		t.Fatal(err, r)
	}
	r, err = runShell(root)(context.Background(), BashArgs{Command: "printf 'ok'"})
	if err != nil || r.IsError || !strings.Contains(r.Content[0].(*mcp.TextContent).Text, "ok") {
		t.Fatal(err, r)
	}
}
func TestPathResolution(t *testing.T) {
	root := t.TempDir()
	p := pathAt(root, "a.txt")
	if p != filepath.Join(root, "a.txt") {
		t.Fatal(p)
	}
	if err := os.WriteFile(p, []byte("ok"), 0600); err != nil {
		t.Fatal(err)
	}
}
