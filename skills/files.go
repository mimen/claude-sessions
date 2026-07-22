package skills

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Files lists bounded readable text/markdown files for the skill reader.
func Files(skill Skill) []File {
	files := make([]File, 0, 32)
	_ = filepath.WalkDir(skill.RealPath, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if path == skill.RealPath {
			return nil
		}
		relative, relErr := filepath.Rel(skill.RealPath, path)
		if relErr != nil {
			return nil
		}
		if entry.IsDir() {
			if strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if len(files) >= 100 || !readableExtension(entry.Name()) {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil || info.Size() > 2*1024*1024 {
			return nil
		}
		files = append(files, File{Relative: relative, Size: info.Size()})
		return nil
	})
	sort.Slice(files, func(i int, j int) bool {
		if files[i].Relative == "SKILL.md" {
			return true
		}
		if files[j].Relative == "SKILL.md" {
			return false
		}
		return files[i].Relative < files[j].Relative
	})
	return files
}

// ReadFile reads one listed relative path while enforcing containment.
func ReadFile(skill Skill, relative string) ([]string, error) {
	root := filepath.Clean(skill.RealPath)
	path := filepath.Clean(filepath.Join(root, relative))
	if path != root && !strings.HasPrefix(path, root+string(filepath.Separator)) {
		return nil, fmt.Errorf("skill file escapes root: %s", relative)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read skill file: %w", err)
	}
	return strings.Split(strings.ReplaceAll(string(contents), "\r\n", "\n"), "\n"), nil
}

func readableExtension(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".md", ".mdx", ".txt", ".json", ".toml", ".yaml", ".yml":
		return true
	default:
		return false
	}
}
