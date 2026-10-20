package com.acme.billing;

import com.acme.auth.AuthService;

public class InvoiceService {
    private final AuthService auth = new AuthService();

    public long total(long[] linesCents) {
        long sum = 0;
        for (long l : linesCents) sum += l;
        return sum;
    }
}
