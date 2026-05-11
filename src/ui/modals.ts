import { App, ButtonComponent, Modal } from 'obsidian';
import { t } from '../i18n';
import { ConflictAction } from '../sync/SessionReport';

/**
 * Generic confirmation modal with searchable, checkbox-selectable list.
 * Resolves with the array of selected paths, or null if cancelled.
 */
export class SelectionModal extends Modal {
    private selected: Set<string>;
    private resolved = false;

    constructor(
        app: App,
        private titleText: string,
        private description: string,
        private paths: string[],
        private confirmLabel: (count: number) => string,
        private destructive: boolean,
        private onResolve: (selected: string[] | null) => void,
    ) {
        super(app);
        this.selected = new Set(paths);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('yds-modal');

        contentEl.createEl('h2', { text: this.titleText });
        contentEl.createEl('p', { text: this.description });

        const toolbar = contentEl.createDiv({ cls: 'yds-toolbar' });
        const search = toolbar.createEl('input', {
            type: 'text',
            placeholder: t('searchPlaceholder'),
            cls: 'yds-search',
        });
        const allBtn = toolbar.createEl('button', { text: t('selectAllBtn'), cls: 'yds-toolbtn' });
        const noneBtn = toolbar.createEl('button', { text: t('selectNoneBtn'), cls: 'yds-toolbtn' });
        const countLabel = toolbar.createEl('span', { cls: 'yds-count' });

        const list = contentEl.createDiv({ cls: 'yds-list' });

        const rows: { row: HTMLDivElement; checkbox: HTMLInputElement; path: string }[] = [];
        for (const p of this.paths) {
            const row = list.createDiv({ cls: 'yds-row' });
            const cb = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
            cb.checked = this.selected.has(p);
            cb.addEventListener('change', () => {
                if (cb.checked) this.selected.add(p);
                else this.selected.delete(p);
                updateCount();
            });
            const label = row.createEl('span', { text: p, cls: 'yds-path' });
            label.addEventListener('click', () => {
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change'));
            });
            rows.push({ row, checkbox: cb, path: p });
        }

        const btns = contentEl.createDiv({ cls: 'yds-btns' });
        new ButtonComponent(btns)
            .setButtonText(t('cancelBtn'))
            .onClick(() => {
                this.resolved = true;
                this.onResolve(null);
                this.close();
            });
        const confirmBtn = new ButtonComponent(btns)
            .setButtonText(this.confirmLabel(this.selected.size))
            .onClick(() => {
                this.resolved = true;
                this.onResolve(Array.from(this.selected));
                this.close();
            });
        if (this.destructive) confirmBtn.setWarning();

        const updateCount = (): void => {
            countLabel.setText(`${this.selected.size} / ${this.paths.length}`);
            confirmBtn.setButtonText(this.confirmLabel(this.selected.size));
            confirmBtn.setDisabled(this.selected.size === 0);
        };

        const applyFilter = (): void => {
            const q = search.value.trim().toLowerCase();
            for (const r of rows) {
                const visible = !q || r.path.toLowerCase().includes(q);
                r.row.toggleClass('yds-hidden', !visible);
            }
        };
        search.addEventListener('input', applyFilter);

        allBtn.addEventListener('click', () => {
            for (const r of rows) {
                if (r.row.hasClass('yds-hidden')) continue;
                r.checkbox.checked = true;
                this.selected.add(r.path);
            }
            updateCount();
        });
        noneBtn.addEventListener('click', () => {
            for (const r of rows) {
                if (r.row.hasClass('yds-hidden')) continue;
                r.checkbox.checked = false;
                this.selected.delete(r.path);
            }
            updateCount();
        });

        updateCount();
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.resolved) this.onResolve(null);
    }
}

/**
 * Conflict modal with bulk action buttons.
 */
export class ConflictModal extends Modal {
    private resolved = false;

    constructor(
        app: App,
        private paths: string[],
        private onResolve: (action: ConflictAction) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('yds-modal');

        contentEl.createEl('h2', { text: t('conflictModalTitle') });
        contentEl.createEl('p', { text: t('conflictModalDesc') });

        const list = contentEl.createDiv({ cls: 'yds-list' });
        for (const p of this.paths) list.createDiv({ cls: 'yds-row yds-row-static', text: p });

        const btns = contentEl.createDiv({ cls: 'yds-btns yds-btns-wrap' });
        new ButtonComponent(btns)
            .setButtonText(t('conflictBtnSkipAll'))
            .onClick(() => this.choose('skip'));
        new ButtonComponent(btns)
            .setButtonText(t('conflictBtnPreferRemoteAll'))
            .onClick(() => this.choose('prefer-remote'));
        new ButtonComponent(btns)
            .setButtonText(t('conflictBtnKeepBothAll'))
            .onClick(() => this.choose('keep-both'));
        new ButtonComponent(btns)
            .setButtonText(t('conflictBtnOverwriteAll'))
            .setWarning()
            .onClick(() => this.choose('overwrite'));
    }

    private choose(action: ConflictAction): void {
        this.resolved = true;
        this.onResolve(action);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.resolved) this.onResolve('skip');
    }
}

/**
 * Generic Yes/No confirmation modal (replaces native confirm()).
 */
export class ConfirmModal extends Modal {
    private resolved = false;

    constructor(
        app: App,
        private titleText: string,
        private bodyText: string,
        private confirmLabel: string,
        private destructive: boolean,
        private onResolve: (confirmed: boolean) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('yds-modal');

        contentEl.createEl('h2', { text: this.titleText });
        contentEl.createEl('p', { text: this.bodyText });

        const btns = contentEl.createDiv({ cls: 'yds-btns' });
        new ButtonComponent(btns)
            .setButtonText(t('cancelBtn'))
            .onClick(() => {
                this.resolved = true;
                this.onResolve(false);
                this.close();
            });
        const okBtn = new ButtonComponent(btns)
            .setButtonText(this.confirmLabel)
            .onClick(() => {
                this.resolved = true;
                this.onResolve(true);
                this.close();
            });
        if (this.destructive) okBtn.setWarning();
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.resolved) this.onResolve(false);
    }
}

/**
 * Progress modal showing current phase and a Cancel button.
 */
export class ProgressModal extends Modal {
    private phaseEl!: HTMLElement;
    private fileEl!: HTMLElement;
    private barEl!: HTMLElement;
    private cancelled = false;
    onCancelled?: () => void;

    constructor(app: App) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('yds-modal');
        contentEl.createEl('h2', { text: t('progressTitle') });
        this.phaseEl = contentEl.createDiv({ cls: 'yds-phase', text: t('progressPhasePlanning') });
        const barWrap = contentEl.createDiv({ cls: 'yds-bar-wrap' });
        this.barEl = barWrap.createDiv({ cls: 'yds-bar' });
        this.fileEl = contentEl.createDiv({ cls: 'yds-file' });
        const btns = contentEl.createDiv({ cls: 'yds-btns' });
        const cancelBtn = new ButtonComponent(btns)
            .setButtonText(t('progressCancelBtn'))
            .onClick(() => {
                this.cancelled = true;
                this.onCancelled?.();
                cancelBtn.setDisabled(true);
            });
    }

    isCancelled(): boolean {
        return this.cancelled;
    }

    update(phase: string, current: number, total: number, file?: string): void {
        if (!this.phaseEl) return;
        this.phaseEl.setText(phase);
        const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
        // Bar width is the only legitimate dynamic style: drive a CSS variable
        // that the stylesheet consumes via width: var(--yds-progress).
        this.barEl.style.setProperty('--yds-progress', pct + '%');
        this.fileEl.setText(file ? `${current} / ${total} — ${file}` : `${current} / ${total}`);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
