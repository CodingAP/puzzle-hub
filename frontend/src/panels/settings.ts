/**
 * frontend/src/panels/settings.ts
 *
 * preferences form; every change applies immediately
 */

import { api } from '../api.ts';
import { formatDate, h, replace } from '../dom.ts';
import { DEFAULT_SETTINGS, type Settings, settings } from '../settings.ts';
import { actions, getState, subscribe } from '../state.ts';
import type { CredentialInfo, SourceInfo } from '../types.ts';
import { THEMES } from '../themes.ts';
import type { PanelDefinition } from '../workspace.ts';

type Field = {
    key: keyof Settings;
    label: string;
    type: 'text' | 'password' | 'number' | 'checkbox' | 'select';
    hint?: string;
    options?: [string, string][];
    min?: number;
};

const SECTIONS: { title: string; fields: Field[] }[] = [
    {
        title: 'connection',
        fields: [
            {
                key: 'token',
                label: 'api token',
                type: 'password',
                hint: 'the API_TOKEN the server was started with (leave empty when the server has no token)',
            },
            {
                key: 'apiBase',
                label: 'api base url',
                type: 'text',
                hint: 'leave empty to use the server that served this page, or point at a remote instance (https://host:8000)',
            },
        ],
    },
    {
        title: 'runner defaults',
        fields: [
            { key: 'defaultPart', label: 'part', type: 'select', options: [['all', 'every part'], ['1', 'part 1'], ['2', 'part 2'], ['3', 'part 3']] },
            { key: 'defaultIterations', label: 'profile iterations', type: 'number', min: 1 },
            { key: 'runTimeoutMs', label: 'run timeout (ms)', type: 'number', min: 1000, hint: "capped by the server's RUN_TIMEOUT_MS" },
            { key: 'defaultRecord', label: 'record answers without submitting by default', type: 'checkbox' },
            { key: 'confirmSubmit', label: 'confirm before real submissions', type: 'checkbox' },
            {
                key: 'profilePush',
                label: 'commit and push the puzzle after profiling',
                type: 'checkbox',
                hint: "git add + commit + push of the puzzle's folder, in its own repository, from the server running the api",
            },
        ],
    },
    {
        title: 'editor',
        fields: [
            { key: 'editorFontSize', label: 'font size', type: 'number', min: 8 },
            { key: 'editorTabSize', label: 'tab size', type: 'number', min: 1 },
            { key: 'editorMinimap', label: 'minimap', type: 'checkbox' },
            { key: 'editorWordWrap', label: 'word wrap', type: 'checkbox' },
        ],
    },
    {
        title: 'appearance',
        fields: [
            { key: 'theme', label: 'theme', type: 'select', options: THEMES.map((theme) => [theme.id, theme.name]) },
            {
                key: 'themeFollowsSource',
                label: 'match the theme to the site',
                type: 'checkbox',
                hint: 'advent of code and everybody codes puzzles switch to their own look; everything else uses the theme above',
            },
            { key: 'snowflakes', label: 'snowflakes', type: 'checkbox' },
        ],
    },
];

export const settingsPanel: PanelDefinition = {
    id: 'settings',
    title: 'Settings',
    create(container, { workspace }) {
        const health = h('span', { className: 'dim' }, 'checking server…');
        const form = h('div', { className: 'settings-form' });

        const checkHealth = async () => {
            try {
                const info = await api.health();
                replace(health, h('span', { className: 'ok' }, `connected · v${info.version} · auth ${info.auth ? 'required' : 'disabled'}`));
                if (info.auth) {
                    // make sure the token is actually accepted
                    await actions.loadHub();
                }
            } catch (error) {
                replace(health, h('span', { className: 'error' }, error instanceof Error ? error.message : String(error)));
            }
        };

        const control = (field: Field): HTMLElement => {
            const value = settings.get()[field.key];
            const commit = (next: unknown) => {
                settings.set({ [field.key]: next } as Partial<Settings>);
                if (field.key === 'token' || field.key === 'apiBase') {
                    checkHealth();
                    actions.loadHub().then(() => {
                        const last = getState().puzzle ?? settings.get().lastPuzzle;
                        if (last) actions.selectPuzzle(last, { force: true });
                    });
                }
            };

            if (field.type === 'checkbox') {
                return h('input', {
                    type: 'checkbox',
                    checked: Boolean(value),
                    onChange: (event: Event) => commit((event.target as HTMLInputElement).checked),
                });
            }
            if (field.type === 'select') {
                const select = h(
                    'select',
                    { onChange: (event: Event) => commit((event.target as HTMLSelectElement).value) },
                    field.options!.map(([v, label]) => h('option', { value: v }, label)),
                );
                select.value = String(value);
                return select;
            }
            return h('input', {
                type: field.type,
                value: String(value ?? ''),
                min: field.min,
                autocomplete: 'off',
                onChange: (event: Event) => {
                    const raw = (event.target as HTMLInputElement).value;
                    commit(field.type === 'number' ? Math.max(field.min ?? 0, Number(raw) || (DEFAULT_SETTINGS[field.key] as number)) : raw.trim());
                },
            });
        };

        // site credentials (session cookies) are stored by the server in its data folder, not in this browser
        const credentials = h('div', { className: 'settings-form credentials' });
        const renderCredentials = () => {
            const sources = getState().hub?.sources ?? [];
            // several sources can share a site; one credential per site
            const providers = new Map<string, SourceInfo>();
            for (const source of sources) if (source.credential && !providers.has(source.provider.id)) providers.set(source.provider.id, source);
            replace(credentials);
            for (const source of providers.values()) {
                const credential = source.credential!;
                const id = `setting-credential-${source.provider.id}`;
                const input = h('input', { type: 'password', autocomplete: 'off', placeholder: `paste the ${credential.label}`, id });
                const status = h('div', { className: 'hint' });
                const show = (info: CredentialInfo) =>
                    replace(
                        status,
                        info.configured
                            ? h(
                                'span',
                                { className: 'ok' },
                                `configured ${info.preview} (from ${info.source}${info.updated ? `, updated ${formatDate(info.updated)}` : ''})`,
                            )
                            : h('span', { className: 'error' }, 'not configured: downloads need it'),
                    );
                const save = async (value: string) => {
                    try {
                        show(await api.setCredential(source.id, value));
                        input.value = '';
                        await actions.loadHub();
                    } catch (error) {
                        replace(status, h('span', { className: 'error' }, error instanceof Error ? error.message : String(error)));
                    }
                };
                input.addEventListener('keydown', (event) => event.key === 'Enter' && save(input.value));
                show(credential);
                credentials.append(
                    h('h3', null, source.provider.name.toLowerCase()),
                    h('label', { htmlFor: id }, credential.label),
                    h(
                        'div',
                        null,
                        input,
                        ' ',
                        h('button', { className: 'link', onClick: () => save(input.value) }, 'save'),
                        ' ',
                        h('button', {
                            className: 'link',
                            onClick: () => {
                                if (confirm(`forget the stored ${credential.label} for ${source.provider.name}?`)) save('');
                            },
                        }, 'clear'),
                    ),
                    status,
                    h(
                        'div',
                        { className: 'hint' },
                        `${credential.hint}. it expires every so often, so paste a new one here when downloads start failing. stored on the server, never in git.`,
                    ),
                );
            }
        };

        const render = () => {
            replace(form);
            for (const section of SECTIONS) {
                form.append(h('h3', null, section.title));
                for (const field of section.fields) {
                    const input = control(field);
                    input.id = `setting-${field.key}`;
                    form.append(h('label', { htmlFor: input.id }, field.label), input);
                    if (field.hint) form.append(h('div', { className: 'hint' }, field.hint));
                }
            }

            form.append(
                h('h3', null, 'layout'),
                h('span', null, 'panels'),
                h(
                    'div',
                    null,
                    h('button', { className: 'link', onClick: () => workspace.reset() }, 'reset layout to default'),
                    ' ',
                    h('button', {
                        className: 'link',
                        onClick: () => {
                            if (confirm('delete all saved layout presets?')) workspace.clearPresets();
                        },
                    }, 'clear saved presets'),
                ),
                h('span', null, 'preferences'),
                h(
                    'div',
                    null,
                    h('button', {
                        className: 'link',
                        onClick: () => {
                            if (confirm('reset all preferences except token and api url?')) {
                                settings.reset();
                                render();
                            }
                        },
                    }, 'reset preferences'),
                ),
            );
        };

        container.append(
            h(
                'div',
                { className: 'panel' },
                h('div', { className: 'toolbar' }, h('span', null, 'server: '), health),
                h('div', { className: 'body' }, credentials, form),
            ),
        );
        render();
        renderCredentials();
        checkHealth();
        const unsubscribe = subscribe(renderCredentials, ['hub']);

        // focus the token field when we were opened because of a 401
        setTimeout(() => {
            if (!settings.get().token) form.querySelector<HTMLInputElement>('#setting-token')?.focus();
        }, 50);

        return { dispose: unsubscribe };
    },
};
