import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
    EDITOR_SESSION_COOKIE,
    getSafeEditorNextPath,
} from '@/lib/editor-auth';
import { EDITOR_AUTH_CONFIG_INVALID_MESSAGE } from '@/lib/editor-api-auth';
import {
    RuntimeEditorAuthConfigInvalidError,
    isRuntimeEditorAuthConfigured,
    isRuntimeEditorAuthSetupEnabled,
    isRuntimeEditorAuthSetupTokenRequired,
    isValidRuntimeEditorSession,
} from '@/lib/editor-auth-runtime';
import { isApplicationSetupComplete } from '@/lib/setup-state';
import { EditorLoginForm } from './EditorLoginForm';

interface EditorLoginPageProps {
    searchParams?: Promise<{
        next?: string | string[];
    }>;
}

export default async function EditorLoginPage({
    searchParams,
}: EditorLoginPageProps) {
    const resolvedSearchParams = await searchParams;
    const rawNextPath = Array.isArray(resolvedSearchParams?.next)
        ? resolvedSearchParams.next[0]
        : resolvedSearchParams?.next;
    const nextPath = getSafeEditorNextPath(rawNextPath);
    const cookieStore = await cookies();
    const session = cookieStore.get(EDITOR_SESSION_COOKIE)?.value;

    try {
        const setupComplete = isApplicationSetupComplete();
        const authConfigured = isRuntimeEditorAuthConfigured();

        if (!setupComplete && !authConfigured) {
            redirect(`/setup?next=${encodeURIComponent(nextPath)}`);
        }

        if (await isValidRuntimeEditorSession(session)) {
            redirect(setupComplete ? nextPath : `/setup?next=${encodeURIComponent(nextPath)}`);
        }

        return (
            <EditorLoginForm
                authConfigured={authConfigured}
                setupEnabled={isRuntimeEditorAuthSetupEnabled()}
                setupTokenRequired={isRuntimeEditorAuthSetupTokenRequired()}
                nextPath={nextPath}
            />
        );
    } catch (error) {
        if (!(error instanceof RuntimeEditorAuthConfigInvalidError)) {
            throw error;
        }

        return (
            <EditorLoginForm
                authConfigured={false}
                setupEnabled={false}
                setupTokenRequired={false}
                nextPath={nextPath}
                authErrorMessage={EDITOR_AUTH_CONFIG_INVALID_MESSAGE}
            />
        );
    }
}
