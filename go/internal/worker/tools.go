package worker

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const maxFile = 32 << 20
const maxOutput = 50_000
const maxGrepBytes = 64 << 20

var shellSlots = make(chan struct{}, 16)

func bounded(s string) string {
	if len(s) <= maxOutput {
		return s
	}
	n := maxOutput
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n] + "\n[Output truncated at 50 KB; narrow your request.]"
}
func reply(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: bounded(s)}}}
}
func failure(err error) *mcp.CallToolResult { r := reply(err.Error()); r.IsError = true; return r }
func pathAt(root, p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(root, p)
}
func add[In any](server *mcp.Server, name, description string, f func(context.Context, In) (*mcp.CallToolResult, error)) {
	mcp.AddTool(server, &mcp.Tool{Name: name, Description: description}, func(ctx context.Context, _ *mcp.CallToolRequest, input In) (*mcp.CallToolResult, any, error) {
		r, e := f(ctx, input)
		if e != nil {
			return failure(e), nil, nil
		}
		return r, nil, nil
	})
}

type ReadArgs struct {
	Path   string `json:"path" jsonschema:"Path to read"`
	Offset int    `json:"offset,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}
type WriteArgs struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type Replacement struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}
type EditArgs struct {
	Path    string        `json:"path"`
	Edits   []Replacement `json:"edits,omitempty"`
	OldText string        `json:"oldText,omitempty"`
	NewText string        `json:"newText,omitempty"`
}
type LsArgs struct {
	Path  string `json:"path,omitempty"`
	Limit int    `json:"limit,omitempty"`
}
type FindArgs struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path,omitempty"`
	Limit   int    `json:"limit,omitempty"`
}
type GrepArgs struct {
	Pattern    string `json:"pattern"`
	Path       string `json:"path,omitempty"`
	Glob       string `json:"glob,omitempty"`
	IgnoreCase bool   `json:"ignoreCase,omitempty"`
	Literal    bool   `json:"literal,omitempty"`
	Context    int    `json:"context,omitempty"`
	Limit      int    `json:"limit,omitempty"`
}
type BashArgs struct {
	Command string  `json:"command"`
	Timeout float64 `json:"timeout,omitempty"`
}

func defaultInt(n, d, cap int) int {
	if n <= 0 {
		return d
	}
	if n > cap {
		return cap
	}
	return n
}
func Register(server *mcp.Server, root string) {
	add(server, "read", "Read text with 1-indexed offset/limit, or supported images", func(_ context.Context, a ReadArgs) (*mcp.CallToolResult, error) {
		if a.Offset < 0 || a.Offset == 0 && a.Limit < 0 {
			return nil, errors.New("invalid offset/limit")
		}
		p := pathAt(root, a.Path)
		stat, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if stat.Size() > maxFile {
			return nil, errors.New("file exceeds 32 MiB")
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		if len(data) > maxFile {
			return nil, errors.New("file exceeds 32 MiB")
		}
		mime := map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}[strings.ToLower(filepath.Ext(p))]
		if mime != "" {
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.ImageContent{Data: []byte(base64.StdEncoding.EncodeToString(data)), MIMEType: mime}}}, nil
		}
		if !utf8.Valid(data) {
			return nil, errors.New("binary file is not a supported image")
		}
		lines := strings.SplitAfter(string(data), "\n")
		start := a.Offset - 1
		if start < 0 {
			start = 0
		}
		if start >= len(lines) {
			return reply(""), nil
		}
		end := start + defaultInt(a.Limit, 2000, 20000)
		if end > len(lines) {
			end = len(lines)
		}
		result := strings.Join(lines[start:end], "")
		if end < len(lines) {
			result += "\n[More lines available; use offset.]"
		}
		return reply(result), nil
	})
	add(server, "write", "Write UTF-8 file; creates parent directories", func(_ context.Context, a WriteArgs) (*mcp.CallToolResult, error) {
		if len(a.Content) > maxFile {
			return nil, errors.New("write exceeds 32 MiB")
		}
		p := pathAt(root, a.Path)
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(p, []byte(a.Content), 0644); err != nil {
			return nil, err
		}
		return reply("Wrote " + p), nil
	})
	add(server, "edit", "Atomically edit unique exact text in one file; supports edits[]", func(_ context.Context, a EditArgs) (*mcp.CallToolResult, error) {
		p, err := filepath.EvalSymlinks(pathAt(root, a.Path))
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if info.Size() > maxFile {
			return nil, errors.New("edit exceeds 32 MiB")
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		if len(raw) > maxFile || !utf8.Valid(raw) {
			return nil, errors.New("file too large or not UTF-8")
		}
		original := string(raw)
		changes := a.Edits
		if len(changes) == 0 && a.OldText != "" {
			changes = []Replacement{{a.OldText, a.NewText}}
		}
		if len(changes) == 0 {
			return nil, errors.New("edits must not be empty")
		}
		type span struct {
			start, end int
			text       string
		}
		spans := make([]span, 0, len(changes))
		for _, e := range changes {
			if e.OldText == "" {
				return nil, errors.New("oldText must not be empty")
			}
			if strings.Count(original, e.OldText) != 1 {
				return nil, fmt.Errorf("oldText must occur exactly once: %.60q", e.OldText)
			}
			i := strings.Index(original, e.OldText)
			spans = append(spans, span{i, i + len(e.OldText), e.NewText})
		}
		sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
		for i := 1; i < len(spans); i++ {
			if spans[i].start < spans[i-1].end {
				return nil, errors.New("edit ranges overlap")
			}
		}
		var out strings.Builder
		cursor := 0
		for _, s := range spans {
			out.WriteString(original[cursor:s.start])
			out.WriteString(s.text)
			cursor = s.end
		}
		out.WriteString(original[cursor:])
		if out.Len() > maxFile {
			return nil, errors.New("edited file exceeds 32 MiB")
		}
		f, err := os.CreateTemp(filepath.Dir(p), ".ai-local-hub-edit-*.tmp")
		if err != nil {
			return nil, err
		}
		defer os.Remove(f.Name())
		if err = f.Chmod(info.Mode().Perm()); err != nil {
			f.Close()
			return nil, err
		}
		if _, err = f.WriteString(out.String()); err != nil {
			f.Close()
			return nil, err
		}
		if err = f.Sync(); err != nil {
			f.Close()
			return nil, err
		}
		if err = f.Close(); err != nil {
			return nil, err
		}
		if err = os.Rename(f.Name(), p); err != nil {
			return nil, err
		}
		return reply("Edited " + p), nil
	})
	add(server, "ls", "List sorted files and folders", func(_ context.Context, a LsArgs) (*mcp.CallToolResult, error) {
		p := pathAt(root, a.Path)
		files, err := os.ReadDir(p)
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(files))
		for _, v := range files {
			n := v.Name()
			if v.IsDir() {
				n += "/"
			}
			names = append(names, n)
		}
		sort.Strings(names)
		limit := defaultInt(a.Limit, 500, 10000)
		if len(names) > limit {
			names = names[:limit]
		}
		return reply(strings.Join(names, "\n")), nil
	})
	add(server, "find", "Find filenames by glob, without traversing generated dependency directories", func(ctx context.Context, a FindArgs) (*mcp.CallToolResult, error) {
		if a.Pattern == "" {
			return nil, errors.New("pattern required")
		}
		p := pathAt(root, a.Path)
		res := make([]string, 0)
		limit := defaultInt(a.Limit, 1000, 10000)
		err := filepath.WalkDir(p, func(path string, d os.DirEntry, e error) error {
			if e != nil {
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if path == p {
				return nil
			}
			if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules" || d.Name() == "target") {
				return filepath.SkipDir
			}
			rel, _ := filepath.Rel(p, path)
			match := matchesGlob(a.Pattern, filepath.ToSlash(rel))
			if match {
				if d.IsDir() {
					rel += "/"
				}
				res = append(res, rel)
				if len(res) >= limit {
					return io.EOF
				}
			}
			return nil
		})
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		sort.Strings(res)
		return reply(strings.Join(res, "\n")), nil
	})
	add(server, "grep", "Search file contents with regex/literal matching and limits", func(ctx context.Context, a GrepArgs) (*mcp.CallToolResult, error) {
		expr := a.Pattern
		if a.Literal {
			expr = regexp.QuoteMeta(expr)
		}
		if a.IgnoreCase {
			expr = "(?i)" + expr
		}
		re, err := regexp.Compile(expr)
		if err != nil {
			return nil, err
		}
		p := pathAt(root, a.Path)
		limit := defaultInt(a.Limit, 100, 10000)
		count := 0
		scanned := int64(0)
		files := 0
		var out strings.Builder
		scan := func(path string) error {
			info, err := os.Stat(path)
			if err != nil || info.IsDir() || info.Size() > maxFile {
				return nil
			}
			rel, _ := filepath.Rel(p, path)
			if a.Glob != "" && !matchesGlob(a.Glob, filepath.ToSlash(rel)) && !matchesGlob(a.Glob, filepath.Base(path)) {
				return nil
			}
			if files >= 20000 || scanned+info.Size() > maxGrepBytes {
				return io.EOF
			}
			files++
			scanned += info.Size()
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			if bytes.IndexByte(data[:min(len(data), 8192)], 0) >= 0 {
				return nil
			}
			lines := strings.Split(string(data), "\n")
			for i, line := range lines {
				if re.MatchString(line) {
					start := i - defaultInt(a.Context, 0, 30)
					if a.Context == 0 {
						start = i
					}
					if start < 0 {
						start = 0
					}
					end := min(len(lines), i+1+min(a.Context, 30))
					for j := start; j < end; j++ {
						kind := "context"
						if j == i {
							kind = "match"
						}
						s := lines[j]
						if len(s) > 4096 {
							s = bounded(s[:4096])
						}
						entry := fmt.Sprintf("%s:%d:%s: %s\n", path, j+1, kind, s)
						if out.Len()+len(entry) > maxOutput {
							return io.EOF
						}
						out.WriteString(entry)
						count++
						if count >= limit {
							return io.EOF
						}
					}
				}
			}
			return nil
		}
		info, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			err = scan(p)
		} else {
			err = filepath.WalkDir(p, func(path string, d os.DirEntry, e error) error {
				if e != nil {
					return nil
				}
				if ctx.Err() != nil {
					return ctx.Err()
				}
				if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules" || d.Name() == "target") {
					return filepath.SkipDir
				}
				if !d.IsDir() {
					return scan(path)
				}
				return nil
			})
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		return reply(strings.TrimSuffix(out.String(), "\n")), nil
	})
	add(server, "bash", "Run shell command with timeout and bounded output", runShell(root))
}
func matchesGlob(pattern, name string) bool {
	pattern = filepath.ToSlash(pattern)
	name = filepath.ToSlash(name)
	if yes, _ := filepath.Match(pattern, filepath.Base(name)); yes {
		return true
	}
	if yes, _ := filepath.Match(pattern, name); yes {
		return true
	}
	if strings.HasPrefix(pattern, "**/") {
		if yes, _ := filepath.Match(strings.TrimPrefix(pattern, "**/"), filepath.Base(name)); yes {
			return true
		}
	}
	return false
}

type cappedBuffer struct {
	mu       sync.Mutex
	b        []byte
	overflow bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	remaining := maxOutput - len(c.b)
	if remaining > 0 {
		c.b = append(c.b, p[:min(len(p), remaining)]...)
	}
	if len(p) > remaining {
		c.overflow = true
	}
	return len(p), nil
}
func (c *cappedBuffer) String() string  { c.mu.Lock(); defer c.mu.Unlock(); return string(c.b) }
func (c *cappedBuffer) Truncated() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.overflow }
func runShell(root string) func(context.Context, BashArgs) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, a BashArgs) (*mcp.CallToolResult, error) {
		if strings.TrimSpace(a.Command) == "" {
			return nil, errors.New("command required")
		}
		if a.Timeout < 0 {
			return nil, errors.New("timeout must be positive")
		}
		select {
		case shellSlots <- struct{}{}:
			defer func() { <-shellSlots }()
		default:
			return nil, errors.New("process capacity reached (16 concurrent commands)")
		}
		timeout := time.Hour
		if a.Timeout > 0 {
			timeout = time.Duration(min(a.Timeout, 86400) * float64(time.Second))
		}
		runCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		shell := "/bin/bash"
		args := []string{"-c", a.Command}
		if runtime.GOOS == "windows" {
			shell = "powershell.exe"
			args = []string{"-NoProfile", "-NonInteractive", "-Command", a.Command}
		}
		cmd := exec.Command(shell, args...)
		cmd.Dir = root
		cmd.Stdin = nil
		// The caller's host API key has already been scrubbed from the worker environment.
		cmd.Env = append(os.Environ(), "PATH="+os.Getenv("PATH")+string(os.PathListSeparator)+"/opt/homebrew/bin"+string(os.PathListSeparator)+"/usr/local/bin")
		configureProcessGroup(cmd)
		var stdout, stderr cappedBuffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		start := time.Now()
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		var err error
		select {
		case err = <-done:
		case <-runCtx.Done():
			terminateProcessGroup(cmd)
			select {
			case err = <-done:
			case <-time.After(2 * time.Second):
				err = runCtx.Err()
			}
		}
		code := any(nil)
		if cmd.ProcessState != nil && cmd.ProcessState.ExitCode() >= 0 {
			code = cmd.ProcessState.ExitCode()
		}
		timedOut := errors.Is(runCtx.Err(), context.DeadlineExceeded)
		out := stdout.String() + stderr.String()
		truncated := stdout.Truncated() || stderr.Truncated() || len(out) > maxOutput
		out = bounded(out)
		if timedOut {
			out += fmt.Sprintf("\nCommand timed out after %s", timeout)
		}
		if truncated && !strings.Contains(out, "[Output truncated") {
			out += "\n[Output truncated at 50 KB.]"
		}
		r := reply(out)
		r.IsError = err != nil || timedOut
		r.StructuredContent = map[string]any{"output": out, "exit_code": code, "wall_time_seconds": time.Since(start).Seconds(), "truncated": truncated, "timed_out": timedOut}
		return r, nil
	}
}
