import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SITE_SETTINGS,
    parseSiteSettings,
    parseSiteSettingsOrThrow,
} from '@/lib/site-settings';

describe('site settings parser', () => {
    it('accepts complete settings and trims string values', () => {
        expect(
            parseSiteSettings({
                ...DEFAULT_SITE_SETTINGS,
                siteName: '  My Site  ',
            })
        ).toEqual({
            ...DEFAULT_SITE_SETTINGS,
            siteName: 'My Site',
        });
    });

    it('rejects missing or blank required values', () => {
        expect(parseSiteSettings({ ...DEFAULT_SITE_SETTINGS, siteName: '' })).toBeNull();
        expect(parseSiteSettings({ ...DEFAULT_SITE_SETTINGS, heroDescription: undefined })).toBeNull();
        expect(() => parseSiteSettingsOrThrow({ ...DEFAULT_SITE_SETTINGS, siteName: '' })).toThrow(
            '站点设置必须包含非空的 siteName。'
        );
    });

    it('fills editable intro card fields for legacy settings files', () => {
        const legacySettings = {
            siteName: 'Legacy Site',
            siteDescription: 'Legacy settings',
            workspaceLabel: 'legacy / workspace',
            heroTitleLineOne: 'Legacy',
            heroTitleLineTwo: 'Settings',
            heroDescription: 'Existing runtime settings should keep working.',
        };

        expect(parseSiteSettings(legacySettings)).toEqual({
            ...DEFAULT_SITE_SETTINGS,
            ...legacySettings,
        });
    });

    it('rejects blank intro card values when they are present', () => {
        expect(parseSiteSettings({ ...DEFAULT_SITE_SETTINGS, introCardTitle: ' ' })).toBeNull();
    });

    it('accepts the optional intro card visibility flag only as a boolean', () => {
        expect(parseSiteSettings({ ...DEFAULT_SITE_SETTINGS, showIntroCard: false })?.showIntroCard).toBe(false);
        expect(parseSiteSettings({ ...DEFAULT_SITE_SETTINGS, showIntroCard: 'false' })).toBeNull();
        expect(() => parseSiteSettingsOrThrow({ ...DEFAULT_SITE_SETTINGS, showIntroCard: 'false' })).toThrow(
            '站点设置 showIntroCard 存在时必须是布尔值。'
        );
    });
});
