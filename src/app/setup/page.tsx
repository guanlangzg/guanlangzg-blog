import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
    EDITOR_SESSION_COOKIE,
    getSafeEditorNextPath,
} from '@/lib/editor-auth';
import {
    isRuntimeEditorAuthConfigured,
    isValidRuntimeEditorSession,
} from '@/lib/editor-auth-runtime';
import { isApplicationSetupComplete } from '@/lib/setup-state';
import { SetupWizard } from './SetupWizard';

interface SetupPageProps {
    searchParams?: Promise<{
        next?: string | string[];
    }>;
}

export default async function SetupPage({ searchParams }: SetupPageProps) {
    const resolvedSearchParams = await searchParams;
    const rawNextPath = Array.isArray(resolvedSearchParams?.next)
        ? resolvedSearchParams.next[0]
        : resolvedSearchParams?.next;
    const nextPath = getSafeEditorNextPath(rawNextPath);

    if (isApplicationSetupComplete()) {
        redirect(nextPath);
    }

    const authConfigured = isRuntimeEditorAuthConfigured();

    if (authConfigured) {
        const cookieStore = await cookies();
        const session = cookieStore.get(EDITOR_SESSION_COOKIE)?.value;

        if (!(await isValidRuntimeEditorSession(session))) {
            redirect(`/editor/login?next=${encodeURIComponent(getSafeEditorNextPath('/editor'))}`);
        }
    }

    return <SetupWizard nextPath={nextPath} />;
}
