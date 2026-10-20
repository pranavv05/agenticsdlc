package com.acme.billing;

import org.springframework.web.bind.annotation.*;
import com.acme.auth.*;

@RestController
public class InvoiceController {
    private final InvoiceService service = new InvoiceService();

    @PostMapping("/invoices/total")
    public long total(@RequestBody long[] lines) { return service.total(lines); }
}
