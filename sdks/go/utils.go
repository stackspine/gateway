package stackspine

import "strings"

func trimRightSlash(s string) string {
	return strings.TrimRight(s, "/")
}

func ifEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func stringOr(v any, fallback string) string {
	if v == nil {
		return fallback
	}
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}

func float64Or(v any, fallback float64) float64 {
	if v == nil {
		return fallback
	}
	if f, ok := v.(float64); ok {
		return f
	}
	return fallback
}

func boolOr(v any, fallback bool) bool {
	if v == nil {
		return fallback
	}
	if b, ok := v.(bool); ok {
		return b
	}
	return fallback
}

func mapOrNil(v any) map[string]any {
	if v == nil {
		return nil
	}
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func intOr(v any, fallback int) int {
	if v == nil {
		return fallback
	}
	// JSON numbers decode as float64 in Go
	if f, ok := v.(float64); ok {
		return int(f)
	}
	if i, ok := v.(int); ok {
		return i
	}
	return fallback
}

func joinLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	if len(lines) == 1 {
		return lines[0]
	}
	return strings.Join(lines, "\n")
}
