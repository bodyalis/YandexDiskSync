import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { DEFAULT_INCLUDED_EXTENSIONS } from '../constants';
import { t } from '../i18n';
import type YandexSyncPlugin from '../main';
import { ConfirmModal } from '../ui/modals';
import { ConflictStrategy, DEFAULT_SETTINGS } from './types';

export class YandexSyncSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: YandexSyncPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        const s = this.plugin.settings;

        // ==== Account ====
        new Setting(containerEl).setName(t('settingAccountHeader')).setHeading();

        new Setting(containerEl)
            .setName(t('settingTokenName'))
            .setDesc(t('settingTokenDesc'))
            .addText((text) => {
                text.inputEl.type = 'password';
                text.setPlaceholder(t('settingTokenPlaceholder'))
                    .setValue(s.yandexToken)
                    .onChange(async (v) => {
                        s.yandexToken = v.trim();
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName(t('settingOAuthTokenName'))
            .setDesc(t('settingOAuthTokenDesc'))
            .addText((text) => {
                text.inputEl.type = 'password';
                text.setPlaceholder(t('settingOAuthTokenPlaceholder'))
                    .setValue(s.yandexOAuthToken)
                    .onChange(async (v) => {
                        s.yandexOAuthToken = v.trim();
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName(t('settingLoginName'))
            .setDesc(t('settingLoginDesc'))
            .addText((text) =>
                text
                    .setPlaceholder(t('settingLoginPlaceholder'))
                    .setValue(s.yandexLogin)
                    .onChange(async (v) => {
                        s.yandexLogin = v.trim();
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(t('settingFolderName'))
            .setDesc(t('settingFolderDesc'))
            .addText((text) =>
                text
                    .setPlaceholder(t('settingFolderPlaceholder'))
                    .setValue(s.syncFolder)
                    .onChange(async (v) => {
                        let p = v.trim();
                        if (p.length > 0) {
                            if (!p.startsWith('/')) p = '/' + p;
                            if (p.endsWith('/')) p = p.slice(0, -1);
                        } else {
                            p = DEFAULT_SETTINGS.syncFolder;
                        }
                        s.syncFolder = p;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl).addButton((btn) =>
            btn
                .setButtonText(t('settingTestConnectionBtn'))
                .setCta()
                .onClick(async () => {
                    btn.setDisabled(true);
                    try {
                        await this.plugin.testConnection();
                    } finally {
                        btn.setDisabled(false);
                    }
                }),
        );

        new Setting(containerEl)
            .setName(t('bootstrapBtnName'))
            .setDesc(t('bootstrapBtnDesc'))
            .addButton((btn) =>
                btn
                    .setButtonText(t('bootstrapBtn'))
                    .setWarning()
                    .onClick(async () => {
                        btn.setDisabled(true);
                        try {
                            await this.plugin.bootstrapFromRemote();
                        } finally {
                            btn.setDisabled(false);
                        }
                    }),
            );

        // ==== Sync behaviour ====
        new Setting(containerEl).setName(t('settingSyncHeader')).setHeading();

        new Setting(containerEl)
            .setName(t('settingTwoWayName'))
            .setDesc(t('settingTwoWayDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.twoWaySync).onChange(async (v) => {
                    s.twoWaySync = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingExtensionsName'))
            .setDesc(t('settingExtensionsDesc'))
            .addText((text) =>
                text
                    .setPlaceholder(t('settingExtensionsPlaceholder'))
                    .setValue(s.includedExtensions.join(', '))
                    .onChange(async (v) => {
                        const parts = v
                            .split(/[,\s]+/)
                            .map((p) => p.trim().replace(/^\./, '').toLowerCase())
                            .filter((p) => p.length > 0);
                        s.includedExtensions =
                            parts.length > 0 ? parts : [...DEFAULT_INCLUDED_EXTENSIONS];
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(t('settingExcludeGlobsName'))
            .setDesc(t('settingExcludeGlobsDesc'))
            .addTextArea((ta) => {
                ta.inputEl.rows = 4;
                ta.inputEl.addClass('yds-textarea');
                ta.setPlaceholder(t('settingExcludeGlobsPlaceholder'))
                    .setValue((s.excludeGlobs ?? []).join('\n'))
                    .onChange(async (v) => {
                        s.excludeGlobs = v
                            .split(/\r?\n/)
                            .map((p) => p.trim())
                            .filter((p) => p.length > 0 && !p.startsWith('#'));
                        await this.plugin.saveSettings();
                    });
            });

        // ==== Obsidian config sync (experimental) ====
        new Setting(containerEl).setName(t('settingObsidianConfigHeader')).setHeading();

        new Setting(containerEl)
            .setName(t('settingSyncObsidianConfigName'))
            .setDesc(t('settingSyncObsidianConfigDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.syncObsidianConfig).onChange(async (v) => {
                    if (v && !s.syncObsidianConfig) {
                        // Show warning before enabling
                        toggle.setValue(false); // revert until user confirms
                        new ConfirmModal(
                            this.app,
                            t('confirmEnableConfigSyncTitle'),
                            t('confirmEnableConfigSyncDesc'),
                            t('confirmEnableConfigSyncBtn'),
                            true,
                            async (ok) => {
                                if (!ok) return;
                                s.syncObsidianConfig = true;
                                toggle.setValue(true);
                                await this.plugin.saveSettings();
                            },
                        ).open();
                        return;
                    }
                    s.syncObsidianConfig = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingExcludePluginDataName'))
            .setDesc(t('settingExcludePluginDataDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.excludeObsidianPluginData).onChange(async (v) => {
                    s.excludeObsidianPluginData = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingExcludePluginBinariesName'))
            .setDesc(t('settingExcludePluginBinariesDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.excludeObsidianPluginBinaries).onChange(async (v) => {
                    s.excludeObsidianPluginBinaries = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingExcludeHotkeysName'))
            .setDesc(t('settingExcludeHotkeysDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.excludeObsidianHotkeys).onChange(async (v) => {
                    s.excludeObsidianHotkeys = v;
                    await this.plugin.saveSettings();
                }),
            );

        // ==== Deletion ====
        new Setting(containerEl).setName(t('settingDeletionHeader')).setHeading();

        new Setting(containerEl)
            .setName(t('settingEnableDeleteName'))
            .setDesc(t('settingEnableDeleteDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.enableDelete).onChange(async (v) => {
                    s.enableDelete = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingConfirmDeleteName'))
            .setDesc(t('settingConfirmDeleteDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.confirmBeforeDelete).onChange(async (v) => {
                    s.confirmBeforeDelete = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingPropfindName'))
            .setDesc(t('settingPropfindDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.enablePropfindReconcile).onChange(async (v) => {
                    s.enablePropfindReconcile = v;
                    await this.plugin.saveSettings();
                }),
            );

        // ==== Trash ====
        new Setting(containerEl).setName(t('settingTrashHeader')).setHeading();

        new Setting(containerEl)
            .setName(t('settingUseTrashName'))
            .setDesc(t('settingUseTrashDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.useTrash).onChange(async (v) => {
                    s.useTrash = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingTrashFolderName'))
            .setDesc(t('settingTrashFolderDesc'))
            .addText((text) =>
                text
                    .setPlaceholder(t('settingTrashFolderPlaceholder'))
                    .setValue(s.trashFolder)
                    .onChange(async (v) => {
                        let p = v.trim().replace(/^\/+|\/+$/g, '');
                        if (!p) p = DEFAULT_SETTINGS.trashFolder;
                        s.trashFolder = p;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(t('settingTrashRetentionName'))
            .setDesc(t('settingTrashRetentionDesc'))
            .addText((text) =>
                text.setValue(String(s.trashRetentionDays)).onChange(async (v) => {
                    const n = parseInt(v, 10);
                    s.trashRetentionDays = isNaN(n) || n < 0 ? 0 : n;
                    await this.plugin.saveSettings();
                }),
            );

        // ==== Conflicts ====
        new Setting(containerEl).setName(t('settingConflictsHeader')).setHeading();

        new Setting(containerEl)
            .setName(t('settingConflictStrategyName'))
            .setDesc(t('settingConflictStrategyDesc'))
            .addDropdown((dd) =>
                dd
                    .addOption('ask', t('conflictAsk'))
                    .addOption('skip', t('conflictSkip'))
                    .addOption('overwrite', t('conflictOverwrite'))
                    .addOption('keep-both', t('conflictKeepBoth'))
                    .addOption('prefer-remote', t('conflictPreferRemote'))
                    .setValue(s.conflictStrategy)
                    .onChange(async (v) => {
                        s.conflictStrategy = v as ConflictStrategy;
                        await this.plugin.saveSettings();
                    }),
            );

        // ==== Auto sync ====
        new Setting(containerEl).setName(t('settingAutoSyncHeader')).setHeading();

        new Setting(containerEl)
            .setName(t('settingSyncIntervalName'))
            .setDesc(t('settingSyncIntervalDesc'))
            .addText((text) =>
                text.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
                    const n = parseInt(v, 10);
                    s.syncIntervalMinutes = isNaN(n) || n < 0 ? 0 : n;
                    await this.plugin.saveSettings();
                    this.plugin.rescheduleAutoSync();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingSyncOnStartupName'))
            .setDesc(t('settingSyncOnStartupDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.syncOnStartup).onChange(async (v) => {
                    s.syncOnStartup = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingSyncOnModifyName'))
            .setDesc(t('settingSyncOnModifyDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.syncOnFileModify).onChange(async (v) => {
                    s.syncOnFileModify = v;
                    await this.plugin.saveSettings();
                    this.plugin.rescheduleAutoSync();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingSyncOnModifyDelayName'))
            .setDesc(t('settingSyncOnModifyDelayDesc'))
            .addText((text) =>
                text.setValue(String(s.syncOnFileModifyDelaySec)).onChange(async (v) => {
                    const n = parseInt(v, 10);
                    s.syncOnFileModifyDelaySec = isNaN(n) || n < 1 ? 30 : n;
                    await this.plugin.saveSettings();
                }),
            );

        // ==== Performance ====
        new Setting(containerEl).setName(t('settingPerformanceHeader')).setHeading();

        new Setting(containerEl)
            .setName(t('settingConcurrencyName'))
            .setDesc(t('settingConcurrencyDesc'))
            .addText((text) =>
                text.setValue(String(s.maxConcurrency)).onChange(async (v) => {
                    const n = parseInt(v, 10);
                    s.maxConcurrency = isNaN(n) || n < 1 ? 1 : Math.min(n, 16);
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingRetriesName'))
            .setDesc(t('settingRetriesDesc'))
            .addText((text) =>
                text.setValue(String(s.maxRetries)).onChange(async (v) => {
                    const n = parseInt(v, 10);
                    s.maxRetries = isNaN(n) || n < 0 ? 0 : Math.min(n, 10);
                    await this.plugin.saveSettings();
                }),
            );

        // ==== Logs ====
        new Setting(containerEl).setName(t('settingLogsHeader')).setHeading();

        new Setting(containerEl)
            .setName(t('settingEnableLogsName'))
            .setDesc(t('settingEnableLogsDesc'))
            .addToggle((toggle) =>
                toggle.setValue(s.enableLogs).onChange(async (v) => {
                    s.enableLogs = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingLogFolderName'))
            .setDesc(t('settingLogFolderDesc'))
            .addText((text) =>
                text
                    .setPlaceholder(t('settingLogFolderPlaceholder'))
                    .setValue(s.localLogFolder)
                    .onChange(async (v) => {
                        let p = v.trim().replace(/^\/+|\/+$/g, '');
                        if (!p) p = DEFAULT_SETTINGS.localLogFolder;
                        s.localLogFolder = p;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(t('settingLogRetentionName'))
            .setDesc(t('settingLogRetentionDesc'))
            .addText((text) =>
                text.setValue(String(s.logRetentionDays)).onChange(async (v) => {
                    const n = parseInt(v, 10);
                    s.logRetentionDays = isNaN(n) || n < 0 ? 0 : n;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settingMaxLogFilesName'))
            .setDesc(t('settingMaxLogFilesDesc'))
            .addText((text) =>
                text.setValue(String(s.maxLogFiles)).onChange(async (v) => {
                    const n = parseInt(v, 10);
                    s.maxLogFiles = isNaN(n) || n < 0 ? 0 : n;
                    await this.plugin.saveSettings();
                }),
            );

        // ==== Advanced ====
        new Setting(containerEl).setName(t('settingAdvancedHeader')).setHeading();

        new Setting(containerEl)
            .setName(t('settingResetManifestName'))
            .setDesc(t('settingResetManifestDesc'))
            .addButton((btn) =>
                btn
                    .setButtonText(t('settingResetManifestBtn'))
                    .setWarning()
                    .onClick(() => {
                        new ConfirmModal(
                            this.app,
                            t('settingResetManifestConfirmTitle'),
                            t('settingResetManifestConfirmDesc'),
                            t('confirmYesBtn'),
                            true,
                            async (ok) => {
                                if (!ok) return;
                                this.plugin.settings.manifest = {};
                                await this.plugin.saveSettings();
                                new Notice(t('noticeManifestCleared'));
                            },
                        ).open();
                    }),
            );
    }
}
