package com.acme.auth;

public class AuthService {
    public boolean isValid(String token) { return token != null && !token.isEmpty(); }
}
