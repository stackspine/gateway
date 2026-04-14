package stackspine

import (
	"encoding/json"
	"fmt"
)

type APIError struct {
	StatusCode int
	Message    string
	RequestID  string
	Details    map[string]any
}

func (e *APIError) Error() string {
	if e.RequestID != "" {
		return fmt.Sprintf("stackspine: status=%d request_id=%s message=%s", e.StatusCode, e.RequestID, e.Message)
	}
	return fmt.Sprintf("stackspine: status=%d message=%s", e.StatusCode, e.Message)
}

func NewAPIError(status int, body []byte, requestID string) *APIError {
	msg := string(body)
	details := map[string]any{}
	// best-effort parse
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err == nil {
		if m, ok := parsed["message"].(string); ok && m != "" {
			msg = m
		} else if m, ok := parsed["error"].(string); ok && m != "" {
			msg = m
		}
		details = parsed
	}
	return &APIError{StatusCode: status, Message: msg, RequestID: requestID, Details: details}
}

// TimeoutError is returned when a request exceeds the configured timeout.
type TimeoutError struct {
	TimeoutSeconds float64
}

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("stackspine: request timed out after %.0fs", e.TimeoutSeconds)
}

// ValidationError is a client-side validation error (request never sent to server).
type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("stackspine: validation error: %s", e.Message)
}

// StreamError is returned when SSE stream parsing fails.
type StreamError struct {
	Message string
}

func (e *StreamError) Error() string {
	return fmt.Sprintf("stackspine: stream error: %s", e.Message)
}

// RateLimitError is returned when a 429 response is received after all retries.
type RateLimitError struct {
	StatusCode int
	Message    string
	RequestID  string
	RetryAfter float64
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("stackspine: rate limited (retry after %.0fs): %s", e.RetryAfter, e.Message)
}

// BudgetExceededError is returned when a 402 response indicates budget exceeded.
type BudgetExceededError struct {
	StatusCode      int
	Message         string
	RequestID       string
	LimitUSD        float64
	CurrentSpendUSD float64
}

func (e *BudgetExceededError) Error() string {
	return fmt.Sprintf("stackspine: budget exceeded (limit=$%.2f, spent=$%.2f): %s", e.LimitUSD, e.CurrentSpendUSD, e.Message)
}

// AllProvidersFailedError is returned when a 503 response indicates all providers are down.
type AllProvidersFailedError struct {
	StatusCode int
	Message    string
	RequestID  string
}

func (e *AllProvidersFailedError) Error() string {
	return fmt.Sprintf("stackspine: all providers failed: %s", e.Message)
}
