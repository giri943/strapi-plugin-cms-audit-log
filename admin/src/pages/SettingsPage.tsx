import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Field,
  Flex,
  Grid,
  MultiSelect,
  MultiSelectOption,
  NumberInput,
  Switch,
  TextInput,
  Typography,
} from '@strapi/design-system';
import { Check } from '@strapi/icons';
import { Layouts, Page, useNotification, useRBAC } from '@strapi/strapi/admin';
import { SupportFooter } from '../components/SupportFooter';
import pluginPermissions, { RBAC_FLAGS, type AllowedActions } from '../permissions';
import { api, type Category, type PluginSettings, type SettingsResponse } from '../utils/api';
import { CATEGORY_LABELS, formatNumber } from '../utils/format';

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <Box background="neutral0" hasRadius shadow="tableShadow" padding={6}>
    <Flex direction="column" alignItems="stretch" gap={4}>
      <Flex direction="column" alignItems="flex-start" gap={1}>
        <Typography variant="delta" tag="h2">
          {title}
        </Typography>
        {hint && (
          <Typography variant="pi" textColor="neutral600">
            {hint}
          </Typography>
        )}
      </Flex>
      {children}
    </Flex>
  </Box>
);

const KEY_SOURCE: Record<SettingsResponse['deployment']['signingKey'], { text: string; variant: 'success' | 'warning' | 'danger' }> = {
  config: { text: 'A dedicated signing secret is configured.', variant: 'success' },
  'admin-secret': {
    text: 'Entries are signed with a key derived from admin.auth.secret. Rotating that secret will make existing entries fail verification. Set signingSecret in config/plugins to avoid this.',
    variant: 'warning',
  },
  none: { text: 'No signing key is available, so new entries are stored unsigned.', variant: 'danger' },
};

const SettingsPage = () => {
  const { isLoading: rbacLoading, allowedActions } = useRBAC([
    ...pluginPermissions.readSettings,
    ...pluginPermissions.updateSettings,
  ]);
  const canEdit = Boolean((allowedActions as AllowedActions)[RBAC_FLAGS.updateSettings]);
  const { toggleNotification } = useNotification();

  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<PluginSettings | null>(null);
  const [redactedText, setRedactedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (response: SettingsResponse) => {
    setData(response);
    setDraft(response.settings);
    setRedactedText(response.settings.redactedFields.join(', '));
  };

  useEffect(() => {
    api.settings().then(load).catch((cause: Error) => setError(cause.message));
  }, []);

  if (rbacLoading) return <Page.Loading />;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const redactedFields = redactedText
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      load(await api.saveSettings({ ...draft, redactedFields }));
      toggleNotification({ type: 'success', message: 'Settings saved. The change is recorded in the audit log.' });
    } catch (cause) {
      toggleNotification({ type: 'danger', message: cause instanceof Error ? cause.message : 'Could not save.' });
    } finally {
      setSaving(false);
    }
  };

  const toggleCategory = (category: Category, recorded: boolean) => {
    if (!draft) return;
    const disabled = new Set(draft.disabledCategories);
    if (recorded) disabled.delete(category);
    else disabled.add(category);
    setDraft({ ...draft, disabledCategories: [...disabled] });
  };

  return (
    <Page.Protect permissions={pluginPermissions.readSettings}>
      <Page.Main>
        <Page.Title>Audit Log settings</Page.Title>
        <Layouts.Header
          title="Audit Log"
          subtitle="Choose what is recorded and how long it is kept."
          primaryAction={
            canEdit ? (
              <Button startIcon={<Check />} onClick={save} loading={saving} disabled={!draft}>
                Save
              </Button>
            ) : undefined
          }
        />
        <Layouts.Content>
          {error && (
            <Alert variant="danger" closeLabel="Close" title="Could not load the settings">
              {error}
            </Alert>
          )}

          {data && draft && (
            <Flex direction="column" alignItems="stretch" gap={4}>
              {!data.deployment.enabled && (
                <Alert variant="warning" closeLabel="Close" title="Recording is off">
                  The plugin is disabled in config/plugins (enabled: false). Existing entries can still be viewed, but nothing new is recorded.
                </Alert>
              )}

              <Section title="Retention" hint="Entries older than this are deleted automatically, every six hours.">
                <Box maxWidth="280px">
                  <Field.Root
                    name="retentionDays"
                    hint={`Between ${data.options.retentionDays.min} and ${formatNumber(data.options.retentionDays.max)} days.`}
                  >
                    <Field.Label>Keep entries for (days)</Field.Label>
                    <NumberInput
                      value={draft.retentionDays}
                      onValueChange={(value: number | undefined) =>
                        setDraft({ ...draft, retentionDays: value ?? data.options.retentionDays.default })
                      }
                      disabled={!canEdit}
                    />
                    <Field.Hint />
                  </Field.Root>
                </Box>
              </Section>

              <Section title="What to record" hint="Changes made by admins in the admin panel are always recorded unless their area is turned off below.">
                <Grid.Root gap={4}>
                  {data.options.categories.map((category) => {
                    const locked = data.options.lockedCategories.includes(category);
                    return (
                      <Grid.Item key={category} col={4} s={6} xs={12}>
                        <Checkbox
                          checked={locked || !draft.disabledCategories.includes(category)}
                          disabled={!canEdit || locked}
                          onCheckedChange={(checked: boolean) => toggleCategory(category, checked)}
                        >
                          {`${CATEGORY_LABELS[category]}${locked ? ' (always on)' : ''}`}
                        </Checkbox>
                      </Grid.Item>
                    );
                  })}
                </Grid.Root>

                <Flex direction="column" alignItems="flex-start" gap={4} paddingTop={2}>
                  <Flex direction="column" alignItems="flex-start" gap={1}>
                    <Typography fontWeight="semiBold">Content API writes</Typography>
                    <Switch
                      checked={draft.captureContentApi}
                      onCheckedChange={(checked: boolean) => setDraft({ ...draft, captureContentApi: checked })}
                      disabled={!canEdit}
                      visibleLabels
                    />
                    <Typography variant="pi" textColor="neutral600">
                      Changes made through the REST or GraphQL API with an API token or a signed-in website user.
                    </Typography>
                  </Flex>
                  <Flex direction="column" alignItems="flex-start" gap={1}>
                    <Typography fontWeight="semiBold">System writes</Typography>
                    <Switch
                      checked={draft.captureSystem}
                      onCheckedChange={(checked: boolean) => setDraft({ ...draft, captureSystem: checked })}
                      disabled={!canEdit}
                      visibleLabels
                    />
                    <Typography variant="pi" textColor="neutral600">
                      Changes with no request behind them, such as seed scripts, scheduled jobs and other plugins. Can be noisy.
                    </Typography>
                  </Flex>
                </Flex>
              </Section>

              <Section title="Exclusions and privacy">
                <Field.Root name="excludedContentTypes" hint="Changes to these content types are not recorded.">
                  <Field.Label>Content types to skip</Field.Label>
                  <MultiSelect
                    value={draft.excludedContentTypes}
                    onChange={(value: string[]) => setDraft({ ...draft, excludedContentTypes: value ?? [] })}
                    disabled={!canEdit}
                    placeholder="None"
                    withTags
                  >
                    {data.options.contentTypes.map((type) => (
                      <MultiSelectOption key={type.uid} value={type.uid}>
                        {type.label}
                      </MultiSelectOption>
                    ))}
                  </MultiSelect>
                  <Field.Hint />
                </Field.Root>

                <Field.Root
                  name="redactedFields"
                  hint="Comma-separated field names whose values are never stored, for example nationalId, phone. Passwords, tokens and secrets are always hidden."
                >
                  <Field.Label>Extra fields to hide</Field.Label>
                  <TextInput
                    value={redactedText}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => setRedactedText(event.target.value)}
                    disabled={!canEdit}
                    placeholder="nationalId, phone"
                  />
                  <Field.Hint />
                </Field.Root>
              </Section>

              <Section title="Protection" hint="Set in config/plugins.ts. These cannot be changed from the admin panel.">
                <Alert variant={KEY_SOURCE[data.deployment.signingKey].variant} closeLabel="Close" title="Tamper detection">
                  {KEY_SOURCE[data.deployment.signingKey].text}
                </Alert>
                <Grid.Root gap={4}>
                  <Grid.Item col={4} s={12} direction="column" alignItems="flex-start">
                    <Typography variant="sigma" textColor="neutral600">Export limit</Typography>
                    <Typography>{`${formatNumber(data.deployment.maxExportRows ?? 0)} rows per file`}</Typography>
                  </Grid.Item>
                  <Grid.Item col={4} s={12} direction="column" alignItems="flex-start">
                    <Typography variant="sigma" textColor="neutral600">Exports</Typography>
                    <Typography>{`${data.deployment.exportsPerMinute ?? 0} per user per minute`}</Typography>
                  </Grid.Item>
                  <Grid.Item col={4} s={12} direction="column" alignItems="flex-start">
                    <Typography variant="sigma" textColor="neutral600">Reads</Typography>
                    <Typography>{`${data.deployment.readsPerMinute ?? 0} per user per minute`}</Typography>
                  </Grid.Item>
                </Grid.Root>
              </Section>
            </Flex>
          )}
          <SupportFooter />
        </Layouts.Content>
      </Page.Main>
    </Page.Protect>
  );
};

export { SettingsPage };
