import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, Flex, Grid, Loader, Typography } from '@strapi/design-system';
import { ArrowClockwise, Download, Shield } from '@strapi/icons';
import { Layouts, Page, useNotification, useRBAC } from '@strapi/strapi/admin';
import { ActivityChart } from '../components/ActivityChart';
import { FilterBar } from '../components/FilterBar';
import { LogDetailModal } from '../components/LogDetailModal';
import { LogTable } from '../components/LogTable';
import { StatCards } from '../components/StatCards';
import { TopList } from '../components/TopList';
import pluginPermissions, { RBAC_FLAGS, type AllowedActions } from '../permissions';
import { api, type FilterOptions, type LogPage, type Stats } from '../utils/api';
import { useCsvDownload } from '../utils/download';
import { DEFAULT_FILTERS, readFilters, RANGE_LABELS, toQuery, writeFilters, type DashboardFilters } from '../utils/filters';
import { formatNumber } from '../utils/format';

const Card = ({ title, children }: { title?: string; children: React.ReactNode }) => (
  <Box background="neutral0" hasRadius shadow="tableShadow" padding={5} height="100%">
    {title && (
      <Box paddingBottom={4}>
        <Typography variant="delta" tag="h2">
          {title}
        </Typography>
      </Box>
    )}
    {children}
  </Box>
);

const DashboardPage = () => {
  const { isLoading: rbacLoading, allowedActions } = useRBAC([
    ...pluginPermissions.readLogs,
    ...pluginPermissions.exportLogs,
  ]);
  const allowed = allowedActions as AllowedActions;
  const { toggleNotification } = useNotification();
  const download = useCsvDownload();

  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);

  const [stats, setStats] = useState<Stats | null>(null);
  const [page, setPage] = useState<LogPage | null>(null);
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const update = useCallback(
    (patch: Partial<DashboardFilters>) => {
      // Any filter change goes back to page 1; paging itself passes `page` explicitly.
      const next = { ...filters, page: 1, ...patch };
      setParams(writeFilters(next), { replace: false });
    },
    [filters, setParams]
  );

  const customIncomplete = filters.range === 'custom' && (!filters.from || !filters.to);

  useEffect(() => {
    api.options().then(setOptions).catch(() => setOptions({ actors: [], actions: [], contentTypes: [], categories: [] }));
  }, [reloadKey]);

  useEffect(() => {
    if (customIncomplete) return;
    let cancelled = false;
    const query = toQuery(filters);

    setLoading(true);
    setError(null);

    Promise.all([api.stats(query), api.logs({ ...query, page: filters.page, pageSize: filters.pageSize })])
      .then(([nextStats, nextPage]) => {
        if (cancelled) return;
        setStats(nextStats);
        setPage(nextPage);
      })
      .catch((cause: Error) => !cancelled && setError(cause.message))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [filters, reloadKey, customIncomplete]);

  const runExport = async () => {
    setExporting(true);
    try {
      const result = await download(api.exportPath(toQuery(filters)), 'audit-log.csv');
      toggleNotification({
        type: result.truncated ? 'warning' : 'success',
        message: result.truncated
          ? `Exported the newest rows only. ${formatNumber(result.total)} matched, which is more than the export limit. Narrow the filters to get the rest.`
          : `Exported ${formatNumber(result.total)} entries.`,
      });
    } catch (cause) {
      toggleNotification({ type: 'danger', message: cause instanceof Error ? cause.message : 'Export failed.' });
    } finally {
      setExporting(false);
    }
  };

  const runVerify = async () => {
    setVerifying(true);
    try {
      const result = await api.verify(toQuery(filters));
      const problems = result.invalid;
      toggleNotification({
        type: problems > 0 ? 'danger' : 'success',
        title: problems > 0 ? 'Tampering detected' : 'Integrity check passed',
        message:
          problems > 0
            ? `${formatNumber(problems)} of ${formatNumber(result.checked)} entries fail their signature check (ids: ${result.invalidIds
                .slice(0, 10)
                .join(', ')}${result.invalidIds.length > 10 ? '…' : ''}).`
            : `All ${formatNumber(result.valid)} signed entries are unchanged${
                result.unsigned > 0 ? `; ${formatNumber(result.unsigned)} were never signed` : ''
              }${result.limitReached ? '. Only the newest entries were checked; narrow the filters to check older ones' : ''}.`,
      });
      setReloadKey((key) => key + 1);
    } catch (cause) {
      toggleNotification({ type: 'danger', message: cause instanceof Error ? cause.message : 'Verification failed.' });
    } finally {
      setVerifying(false);
    }
  };

  if (rbacLoading) return <Page.Loading />;

  const subtitle = `${RANGE_LABELS[filters.range]}${
    filters.range === 'custom' && filters.from && filters.to ? ` (${filters.from} to ${filters.to})` : ''
  }`;

  return (
    <Page.Protect permissions={pluginPermissions.readLogs}>
      <Page.Main>
        <Page.Title>Audit Log</Page.Title>
        <Layouts.Header
          title="Audit Log"
          subtitle={`Who changed what in the CMS, and when. ${subtitle}.`}
          primaryAction={
            allowed[RBAC_FLAGS.exportLogs] ? (
              <Button startIcon={<Download />} onClick={runExport} loading={exporting} disabled={customIncomplete}>
                Export CSV
              </Button>
            ) : undefined
          }
          secondaryAction={
            <Flex gap={2}>
              <Button variant="tertiary" startIcon={<ArrowClockwise />} onClick={() => setReloadKey((key) => key + 1)}>
                Refresh
              </Button>
              <Button variant="secondary" startIcon={<Shield />} onClick={runVerify} loading={verifying} disabled={customIncomplete}>
                Verify integrity
              </Button>
            </Flex>
          }
        />

        <Layouts.Content>
          <Flex direction="column" alignItems="stretch" gap={4}>
            <FilterBar filters={filters} options={options} onChange={update} onReset={() => setParams(writeFilters({ ...DEFAULT_FILTERS, range: filters.range, from: filters.from, to: filters.to }))} />

            {customIncomplete && (
              <Alert variant="default" closeLabel="Close" title="Pick both dates">
                Choose a start and an end date to see the custom range.
              </Alert>
            )}

            {error && (
              <Alert variant="danger" closeLabel="Close" title="Could not load the audit log" onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            {stats && (
              <>
                <StatCards stats={stats} />
                {stats.sampled && (
                  <Typography variant="pi" textColor="neutral600">
                    The breakdowns below are based on the newest 100,000 entries in this period. Totals are exact.
                  </Typography>
                )}

                <Grid.Root gap={4}>
                  <Grid.Item col={8} s={12} direction="column" alignItems="stretch">
                    <Card title="Activity per day">
                      <ActivityChart perDay={stats.perDay} />
                    </Card>
                  </Grid.Item>
                  <Grid.Item col={4} s={12} direction="column" alignItems="stretch">
                    <Card>
                      <Flex direction="column" alignItems="stretch" gap={6}>
                        <TopList
                          title="Most active"
                          empty="Nobody yet."
                          items={stats.topActors.map((actor) => ({
                            key: `${actor.type}:${actor.id}`,
                            label: actor.label,
                            count: actor.count,
                            onSelect: () => update({ actor: `${actor.type}:${actor.id}` }),
                          }))}
                        />
                        <TopList
                          title="Most edited content types"
                          empty="No content changes."
                          items={stats.topContentTypes.map((type) => ({
                            key: type.uid,
                            label: type.label,
                            count: type.count,
                            onSelect: () => update({ contentType: type.uid, category: 'content' }),
                          }))}
                        />
                      </Flex>
                    </Card>
                  </Grid.Item>
                </Grid.Root>
              </>
            )}

            {page ? (
              <LogTable
                page={page}
                loading={loading}
                onOpen={setOpenId}
                onPage={(next) => setParams(writeFilters({ ...filters, page: next }))}
                onPageSize={(size) => update({ pageSize: size })}
              />
            ) : (
              loading && (
                <Flex justifyContent="center" padding={10}>
                  <Loader>Loading activity…</Loader>
                </Flex>
              )
            )}
          </Flex>
        </Layouts.Content>

        {openId !== null && <LogDetailModal id={openId} onClose={() => setOpenId(null)} />}
      </Page.Main>
    </Page.Protect>
  );
};

export { DashboardPage };
