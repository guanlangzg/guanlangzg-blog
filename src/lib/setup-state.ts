import { isRuntimeEditorAuthConfigured } from '@/lib/editor-auth-runtime';
import { readStoredAppRuntimeConfig } from '@/lib/app-runtime-config';

export function isApplicationSetupComplete(): boolean {
    return Boolean(readStoredAppRuntimeConfig()?.setupCompletedAt && isRuntimeEditorAuthConfigured());
}
