package tunnel

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyArchive(t *testing.T) {
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	f, _ := w.Create("folder/tunnel-client")
	_, _ = f.Write([]byte("fake-binary"))
	_ = w.Close()
	out, err := extractZIP(b.Bytes(), "tunnel-client")
	if err != nil || string(out) != "fake-binary" {
		t.Fatal(err)
	}
	if _, err := extractZIP(b.Bytes(), "missing"); err == nil {
		t.Fatal("missing binary accepted")
	}
}
func TestCachedBinaryHash(t *testing.T) {
	dir := t.TempDir()
	m := manifest{Version: "v0.0.1", Platform: "darwin", Arch: "arm64", AssetName: "archive", ExecutableName: "tunnel-client", BinarySHA256: Hash([]byte("good"))}
	_ = os.WriteFile(filepath.Join(dir, "tunnel-client"), []byte("good"), 0700)
	_ = os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(`{"version":"v0.0.1","platform":"darwin","arch":"arm64","assetName":"archive","executableName":"tunnel-client","binarySha256":"`+m.BinarySHA256+`"}`), 0600)
	if _, ok := verify(dir, m); !ok {
		t.Fatal("valid cache rejected")
	}
	_ = os.WriteFile(filepath.Join(dir, "tunnel-client"), []byte("bad"), 0700)
	if _, ok := verify(dir, m); ok {
		t.Fatal("corrupted cache reused")
	}
}
