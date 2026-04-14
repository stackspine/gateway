package stackspine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// StreamEvent represents a single SSE event from StackSpine.
type StreamEvent struct {
	Type  string         `json:"type"`
	Data  map[string]any `json:"data"`
	ID    string         `json:"id,omitempty"`
	Event string         `json:"event,omitempty"`
}

// Stream holds a channel of events and any terminal error.
type Stream struct {
	Events <-chan StreamEvent
	Err    error
}

// Stream opens a streaming task invocation and returns events via a channel.
// The goroutine respects context cancellation.
func (c *Client) Stream(ctx context.Context, task string, input map[string]any, metadata map[string]any) (*Stream, error) {
	payload := map[string]any{"input": input}
	if metadata != nil {
		payload["metadata"] = metadata
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	url := c.BaseURL + fmt.Sprintf("/v1/tasks/%s/stream", task)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	c.authHeaders(req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		return nil, NewAPIError(resp.StatusCode, data, resp.Header.Get("x-request-id"))
	}

	events := make(chan StreamEvent)
	s := &Stream{Events: events}

	go func() {
		defer resp.Body.Close()
		defer close(events)

		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)

		var cur StreamEvent
		var dataLines []string

		flush := func() {
			if len(dataLines) == 0 && cur.Type == "" && cur.Event == "" && cur.ID == "" {
				cur = StreamEvent{}
				return
			}
			dataStr := joinLines(dataLines)
			if dataStr == "" || dataStr == "[DONE]" {
				if cur.Type == "" {
					cur.Type = ifEmpty(cur.Event, "done")
				}
				cur.Data = map[string]any{}
			} else {
				var decoded any
				if err := json.Unmarshal([]byte(dataStr), &decoded); err == nil {
					if m, ok := decoded.(map[string]any); ok {
						cur.Data = m
					} else {
						cur.Data = map[string]any{"value": decoded}
					}
				} else {
					cur.Data = map[string]any{"text": dataStr}
				}
				if cur.Type == "" {
					cur.Type = ifEmpty(cur.Event, "message")
				}
			}

			// Send event, respecting context cancellation
			select {
			case events <- cur:
			case <-ctx.Done():
				s.Err = ctx.Err()
				cur = StreamEvent{}
				dataLines = nil
				return
			}
			cur = StreamEvent{}
			dataLines = nil
		}

		for sc.Scan() {
			// Check for context cancellation between lines
			select {
			case <-ctx.Done():
				s.Err = ctx.Err()
				return
			default:
			}

			line := sc.Text()
			if line == "" {
				flush()
				continue
			}
			if len(line) > 0 && line[0] == ':' {
				continue
			}
			field, val := splitSSE(line)
			switch field {
			case "event":
				cur.Event = val
			case "id":
				cur.ID = val
			case "type":
				cur.Type = val
			case "data":
				dataLines = append(dataLines, val)
			}
		}

		// Flush any remaining partial event
		if len(dataLines) > 0 || cur.Type != "" || cur.Event != "" {
			flush()
		}

		if err := sc.Err(); err != nil {
			s.Err = &StreamError{Message: err.Error()}
		}
	}()

	return s, nil
}

func splitSSE(line string) (string, string) {
	for i := 0; i < len(line); i++ {
		if line[i] == ':' {
			field := line[:i]
			val := line[i+1:]
			if len(val) > 0 && val[0] == ' ' {
				val = val[1:]
			}
			return field, val
		}
	}
	return line, ""
}
