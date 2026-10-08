package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	stateCookie   = "tv_state"
	sessionLength = 7 * 24 * time.Hour
)

type auth struct {
	clientID     string
	apiKey       string
	redirectURI  string
	apiBase      string
	signingKey   []byte
	sessionName  string
	client       *http.Client
	now          func() time.Time
	cookieDomain string
	afterSignIn  string
}

func newAuth(clientID, apiKey, redirectURI, apiBase string) *auth {
	mac := hmac.New(sha256.New, []byte(apiKey))
	mac.Write([]byte("turbo-vibe example session"))
	return &auth{
		clientID:    clientID,
		apiKey:      apiKey,
		redirectURI: redirectURI,
		apiBase:     strings.TrimSuffix(apiBase, "/"),
		signingKey:  mac.Sum(nil),
		sessionName: "tv_session_" + hex.EncodeToString(mac.Sum(nil)[:4]),
		client:      &http.Client{Timeout: 10 * time.Second},
		now:         time.Now,
		afterSignIn: "/",
	}
}

func (a *auth) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/login", a.login)
	mux.HandleFunc("GET /api/auth/callback", a.callback)
	mux.HandleFunc("GET /api/me", a.me)
}

func (a *auth) login(w http.ResponseWriter, r *http.Request) {
	nonce := make([]byte, 16)
	rand.Read(nonce)
	state := hex.EncodeToString(nonce)
	http.SetCookie(w, &http.Cookie{
		Name: stateCookie, Value: state, Path: "/api/auth", MaxAge: 600,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	})
	query := url.Values{
		"client_id":     {a.clientID},
		"redirect_uri":  {a.redirectURI},
		"response_type": {"code"},
		"provider":      {"authkit"},
		"state":         {state},
	}
	http.Redirect(w, r, a.apiBase+"/user_management/authorize?"+query.Encode(), http.StatusFound)
}

func (a *auth) callback(w http.ResponseWriter, r *http.Request) {
	expected, err := r.Cookie(stateCookie)
	if err != nil || expected.Value == "" || r.URL.Query().Get("state") != expected.Value {
		http.Error(w, "sign-in state does not match; start again", http.StatusBadRequest)
		return
	}
	email, err := a.authenticate(r.URL.Query().Get("code"))
	if err != nil {
		http.Error(w, "sign-in failed", http.StatusBadGateway)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: stateCookie, Path: "/api/auth", MaxAge: -1})
	http.SetCookie(w, &http.Cookie{
		Name: a.sessionName, Value: a.sign(email), Path: "/", Domain: a.cookieDomain, MaxAge: int(sessionLength.Seconds()),
		HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, a.afterSignIn, http.StatusFound)
}

func (a *auth) authenticate(code string) (string, error) {
	body, _ := json.Marshal(map[string]string{
		"client_id":     a.clientID,
		"client_secret": a.apiKey,
		"grant_type":    "authorization_code",
		"code":          code,
	})
	response, err := a.client.Post(a.apiBase+"/user_management/authenticate", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("authenticate: HTTP %d", response.StatusCode)
	}
	var result struct {
		User struct {
			Email string `json:"email"`
		} `json:"user"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return "", err
	}
	if result.User.Email == "" {
		return "", fmt.Errorf("authenticate: no email in response")
	}
	return result.User.Email, nil
}

func (a *auth) me(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	cookie, err := r.Cookie(a.sessionName)
	email, ok := "", false
	if err == nil {
		email, ok = a.verify(cookie.Value)
	}
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]any{"email": nil})
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"email": email})
}

func (a *auth) sign(email string) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(email)) + "." +
		strconv.FormatInt(a.now().Add(sessionLength).Unix(), 10)
	return payload + "." + a.mac(payload)
}

func (a *auth) verify(value string) (string, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return "", false
	}
	payload := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(parts[2]), []byte(a.mac(payload))) {
		return "", false
	}
	expires, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || a.now().Unix() > expires {
		return "", false
	}
	email, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	return string(email), true
}

func (a *auth) mac(payload string) string {
	mac := hmac.New(sha256.New, a.signingKey)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
