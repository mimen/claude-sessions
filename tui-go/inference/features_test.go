package inference

import (
	"testing"

	"github.com/mimen/claude-sessions/tui-go/data"
)

func TestValidateMutationResolvesNumberedParent(t *testing.T) {
	sessions := []data.Session{{ID: "focus"}, {ID: "parent"}}
	value := "#2"
	mutation, err := validateMutation(rawMutation{N: 1, Op: "parent", Value: &value}, sessions, sessions[0], map[string]bool{})
	if err != nil {
		t.Fatal(err)
	}
	if mutation.Value == nil || *mutation.Value != "parent" {
		t.Fatalf("mutation = %+v", mutation)
	}
}

func TestValidateMutationRejectsDangerousIdentityFields(t *testing.T) {
	field := "stage"
	value := "done"
	_, err := validateMutation(rawMutation{N: 1, Op: "identity_field", Field: &field, Value: &value}, nil, data.Session{ID: "focus", IdentityKey: "key"}, map[string]bool{})
	if err == nil {
		t.Fatal("expected stage field rejection")
	}
}

func TestValidateMutationRequiresKnownIdentity(t *testing.T) {
	value := "invented:key"
	_, err := validateMutation(rawMutation{N: 1, Op: "identity", Value: &value}, nil, data.Session{ID: "focus"}, map[string]bool{"known:key": true})
	if err == nil {
		t.Fatal("expected unknown identity rejection")
	}
}
