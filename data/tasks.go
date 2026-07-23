package data

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type taskRecord struct {
	ID      string `json:"id"`
	Subject string `json:"subject"`
	Status  string `json:"status"`
}

type taskSummary struct {
	Subjects   []string
	Done       int
	InProgress int
	Total      int
}

func loadTaskSummaries(home string) map[string]taskSummary {
	root := strings.TrimSpace(os.Getenv("CCS_TASKS_PATH"))
	if root == "" {
		root = filepath.Join(home, ".claude", "tasks")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return map[string]taskSummary{}
	}
	out := make(map[string]taskSummary)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(root, entry.Name()))
		if err != nil {
			continue
		}
		tasks := make([]taskRecord, 0, len(files))
		for _, file := range files {
			if file.IsDir() || filepath.Ext(file.Name()) != ".json" {
				continue
			}
			contents, err := os.ReadFile(filepath.Join(root, entry.Name(), file.Name()))
			if err != nil {
				continue
			}
			var task taskRecord
			if json.Unmarshal(contents, &task) != nil {
				continue
			}
			task.Subject = normalizeInline(task.Subject)
			if task.Subject == "" {
				continue
			}
			tasks = append(tasks, task)
		}
		if len(tasks) == 0 {
			continue
		}
		sort.SliceStable(tasks, func(i int, j int) bool {
			return taskOrder(tasks[i].ID) < taskOrder(tasks[j].ID)
		})
		summary := taskSummary{Subjects: make([]string, 0, len(tasks)), Total: len(tasks)}
		for _, task := range tasks {
			summary.Subjects = append(summary.Subjects, task.Subject)
			switch task.Status {
			case "completed":
				summary.Done++
			case "in_progress":
				summary.InProgress++
			}
		}
		out[entry.Name()] = summary
	}
	return out
}

func taskOrder(id string) string {
	if id == "" {
		return "999999999999"
	}
	return strings.Repeat("0", maxInt(0, 12-len(id))) + id
}
