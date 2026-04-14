package stackspine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net"
	"net/http"
	"time"
)

const DefaultBaseURL = "https://api.stackspine.ai"
const DefaultMaxRetries = 3

// Option configures a Client.
type Option func(*Client)

func WithBaseURL(baseURL string) Option {
	return func(c *Client) { c.BaseURL = trimRightSlash(baseURL) }
}

func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) { c.HTTP = hc }
}

func WithTimeout(d time.Duration) Option {
	return func(c *Client) { c.HTTP.Timeout = d }
}

func WithMaxRetries(n int) Option {
	return func(c *Client) { c.MaxRetries = n }
}

// Client is the StackSpine API client.
type Client struct {
	APIKey     string
	BaseURL    string
	HTTP       *http.Client
	Headers    map[string]string
	MaxRetries int
}

func NewClient(apiKey string, opts ...Option) *Client {
	c := &Client{
		APIKey:  apiKey,
		BaseURL: DefaultBaseURL,
		HTTP: &http.Client{
			Timeout: 60 * time.Second,
		},
		Headers:    map[string]string{},
		MaxRetries: DefaultMaxRetries,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

func (c *Client) authHeaders(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	for k, v := range c.Headers {
		req.Header.Set(k, v)
	}
}

// isTimeoutErr checks whether an error is a timeout (context deadline or net timeout).
func isTimeoutErr(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// backoffDelay returns exponential backoff with jitter, capped at 30s.
func backoffDelay(attempt int) time.Duration {
	base := math.Pow(2, float64(attempt)) * 1000 // ms
	jitter := rand.Float64() * 1000
	ms := math.Min(base+jitter, 30000)
	return time.Duration(ms) * time.Millisecond
}

// Do executes a non-streaming request with automatic retries.
func (c *Client) Do(ctx context.Context, method, path string, body any, out any) (*http.Response, error) {
	return c.doWithRetry(ctx, method, path, body, out, 0)
}

func (c *Client) doWithRetry(ctx context.Context, method, path string, body any, out any, attempt int) (*http.Response, error) {
	var rdr io.Reader
	var bodyBytes []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyBytes = b
		rdr = bytes.NewReader(b)
	}

	url := c.BaseURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, rdr)
	if err != nil {
		return nil, err
	}
	c.authHeaders(req)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		// Wrap timeout errors in TimeoutError
		if isTimeoutErr(err) {
			if attempt < c.MaxRetries {
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(backoffDelay(attempt)):
				}
				return c.doWithRetry(ctx, method, path, body, out, attempt+1)
			}
			return nil, &TimeoutError{TimeoutSeconds: c.HTTP.Timeout.Seconds()}
		}
		// Other network errors — retry
		if attempt < c.MaxRetries {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoffDelay(attempt)):
			}
			if bodyBytes != nil {
				_ = bodyBytes
			}
			return c.doWithRetry(ctx, method, path, body, out, attempt+1)
		}
		return nil, err
	}

	// Always close body when we handle it ourselves
	if out == nil {
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, NewAPIError(resp.StatusCode, nil, resp.Header.Get("x-request-id"))
		}
		return resp, nil
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// Retry on retryable status codes
	if resp.StatusCode == 429 || resp.StatusCode >= 500 {
		if attempt < c.MaxRetries {
			delay := backoffDelay(attempt)
			if resp.StatusCode == 429 {
				if ra := resp.Header.Get("Retry-After"); ra != "" {
					if secs, err := time.ParseDuration(ra + "s"); err == nil {
						delay = secs
					}
				}
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
			return c.doWithRetry(ctx, method, path, body, out, attempt+1)
		}
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		reqID := resp.Header.Get("x-request-id")
		// Return typed errors for specific status codes
		if resp.StatusCode == 429 {
			apiErr := NewAPIError(resp.StatusCode, data, reqID)
			retryAfter := float64(60)
			if ra := resp.Header.Get("Retry-After"); ra != "" {
				if parsed, err := fmt.Sscanf(ra, "%f", &retryAfter); err != nil || parsed == 0 {
					retryAfter = 60
				}
			}
			return nil, &RateLimitError{StatusCode: resp.StatusCode, Message: apiErr.Message, RequestID: reqID, RetryAfter: retryAfter}
		}
		if resp.StatusCode == 402 {
			apiErr := NewAPIError(resp.StatusCode, data, reqID)
			return nil, &BudgetExceededError{
				StatusCode:      resp.StatusCode,
				Message:         apiErr.Message,
				RequestID:       reqID,
				LimitUSD:        float64Or(apiErr.Details["limit_usd"], 0),
				CurrentSpendUSD: float64Or(apiErr.Details["current_spend_usd"], 0),
			}
		}
		if resp.StatusCode == 503 {
			apiErr := NewAPIError(resp.StatusCode, data, reqID)
			return nil, &AllProvidersFailedError{StatusCode: resp.StatusCode, Message: apiErr.Message, RequestID: reqID}
		}
		return nil, NewAPIError(resp.StatusCode, data, reqID)
	}

	if err := json.Unmarshal(data, out); err != nil {
		if m, ok := out.(*map[string]any); ok {
			(*m)["raw"] = string(data)
			return resp, nil
		}
		return nil, err
	}
	return resp, nil
}

// Health checks API availability.
func (c *Client) Health(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	_, err := c.Do(ctx, http.MethodGet, "/v1/health", nil, &out)
	return out, err
}

// Usage contains token usage information from a run.
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

// RunResponse contains the result of a task invocation.
type RunResponse struct {
	ID            string         `json:"id"`
	Task          string         `json:"task"`
	Status        string         `json:"status"`
	Model         string         `json:"model"`
	Provider      string         `json:"provider"`
	Content       string         `json:"content"`
	Output        map[string]any `json:"output"`
	Usage         *Usage         `json:"usage"`
	CostUSD       float64        `json:"cost_usd"`
	LatencyMs     float64        `json:"latency_ms"`
	WasCanary     bool           `json:"was_canary"`
	RouteStrategy string         `json:"route_strategy"`
	Raw           map[string]any `json:"-"`
}

// Run executes a task synchronously.
func (c *Client) Run(ctx context.Context, task string, input map[string]any, metadata map[string]any) (*RunResponse, error) {
	payload := map[string]any{"input": input}
	if metadata != nil {
		payload["metadata"] = metadata
	}

	raw := map[string]any{}
	_, err := c.Do(ctx, http.MethodPost, fmt.Sprintf("/v1/tasks/%s/run", task), payload, &raw)
	if err != nil {
		return nil, err
	}

	// Normalize usage: handle both prompt_tokens/input_tokens variants
	usage := &Usage{}
	if u := mapOrNil(raw["usage"]); u != nil {
		usage.InputTokens = intOr(u["input_tokens"], intOr(u["prompt_tokens"], 0))
		usage.OutputTokens = intOr(u["output_tokens"], intOr(u["completion_tokens"], 0))
		usage.TotalTokens = intOr(u["total_tokens"], 0)
		if usage.TotalTokens == 0 {
			usage.TotalTokens = usage.InputTokens + usage.OutputTokens
		}
	}

	resp := &RunResponse{
		ID:            fmt.Sprint(raw["id"]),
		Task:          task,
		Status:        stringOr(raw["status"], "succeeded"),
		Model:         stringOr(raw["model"], ""),
		Provider:      stringOr(raw["provider"], ""),
		Content:       stringOr(raw["content"], ""),
		Output:        mapOrNil(raw["output"]),
		Usage:         usage,
		CostUSD:       float64Or(raw["cost_usd"], 0),
		LatencyMs:     float64Or(raw["latency_ms"], 0),
		WasCanary:     boolOr(raw["was_canary"], false),
		RouteStrategy: stringOr(raw["route_strategy"], ""),
		Raw:           raw,
	}
	return resp, nil
}
