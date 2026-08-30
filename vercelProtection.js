/**
 * Return Vercel's automation-bypass header only for the configured HyperFlow
 * origin. Callback URLs are persisted external input, so a host match is
 * mandatory before the secret can leave this service.
 */
export function hyperflowProtectionHeaders(target, trustedHyperflowUrl = process.env.HYPERFLOW_EVENT_URL) {
    const secret = String(process.env.HYPERFLOW_VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
    if (!secret || !target || !trustedHyperflowUrl) return {};
    try {
        const destination = new URL(target);
        const trusted = new URL(trustedHyperflowUrl);
        if (destination.protocol !== 'https:' || trusted.protocol !== 'https:' || destination.origin !== trusted.origin) return {};
        return { 'x-vercel-protection-bypass': secret };
    } catch {
        return {};
    }
}
