interface JsonLdProps {
    data: Record<string, unknown>;
}

// `<` must be escaped or a title containing `</script>` would break out of the
// data block. A ld+json block is data rather than executable code, so it is not
// covered by the CSP script-src nonce.
function serializeJsonLd(data: Record<string, unknown>): string {
    return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function JsonLd({ data }: JsonLdProps) {
    return (
        <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
        />
    );
}
