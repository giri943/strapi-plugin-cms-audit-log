import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Combobox,
  ComboboxOption,
  Field,
  Flex,
  SingleSelect,
  SingleSelectOption,
  TextInput,
} from '@strapi/design-system';
import { Cross, Search } from '@strapi/icons';
import type { FilterOptions } from '../utils/api';
import { ACTOR_TYPE_LABELS, CATEGORY_LABELS } from '../utils/format';
import { activeFilterCount, RANGE_LABELS, type DashboardFilters, type RangeKey } from '../utils/filters';

interface Props {
  filters: DashboardFilters;
  options: FilterOptions | null;
  onChange(patch: Partial<DashboardFilters>): void;
  onReset(): void;
}

const ALL = '__all__';

/**
 * One row of filters above the dashboard. Every change resets to page 1 and applies to the
 * stat tiles, the chart, the table and the export alike, so what is exported is what is shown.
 */
export const FilterBar = ({ filters, options, onChange, onReset }: Props) => {
  const [search, setSearch] = useState(filters.q ?? '');

  useEffect(() => setSearch(filters.q ?? ''), [filters.q]);

  // Typing is debounced so each keystroke does not cost three requests.
  useEffect(() => {
    if ((filters.q ?? '') === search) return;
    const timer = window.setTimeout(() => onChange({ q: search || undefined }), 400);
    return () => window.clearTimeout(timer);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (key: keyof DashboardFilters) => (value: string | number) =>
    onChange({ [key]: String(value) === ALL ? undefined : String(value) } as Partial<DashboardFilters>);

  const activeCount = activeFilterCount(filters);

  return (
    <Box background="neutral0" hasRadius shadow="tableShadow" padding={4}>
      <Flex gap={3} wrap="wrap" alignItems="flex-end">
        <Box minWidth="170px">
          <Field.Root name="range">
            <Field.Label>Period</Field.Label>
            <SingleSelect value={filters.range} onChange={(value: string | number) => onChange({ range: String(value) as RangeKey })}>
              {(Object.keys(RANGE_LABELS) as RangeKey[]).map((key) => (
                <SingleSelectOption key={key} value={key}>
                  {RANGE_LABELS[key]}
                </SingleSelectOption>
              ))}
            </SingleSelect>
          </Field.Root>
        </Box>

        {filters.range === 'custom' && (
          <>
            <Box minWidth="150px">
              <Field.Root name="from">
                <Field.Label>From</Field.Label>
                <Field.Input
                  type="date"
                  value={filters.from ?? ''}
                  max={filters.to}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ from: event.target.value || undefined })}
                />
              </Field.Root>
            </Box>
            <Box minWidth="150px">
              <Field.Root name="to">
                <Field.Label>To</Field.Label>
                <Field.Input
                  type="date"
                  value={filters.to ?? ''}
                  min={filters.from}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ to: event.target.value || undefined })}
                />
              </Field.Root>
            </Box>
          </>
        )}

        <Box minWidth="240px">
          <Field.Root name="actor">
            <Field.Label>User</Field.Label>
            <Combobox
              value={filters.actor ?? ''}
              placeholder="Anyone"
              onChange={(value?: string) => onChange({ actor: value || undefined })}
              onClear={() => onChange({ actor: undefined })}
              noOptionsMessage={() => 'No matching users'}
              disabled={!options}
            >
              {(options?.actors ?? []).map((actor) => (
                <ComboboxOption key={`${actor.type}:${actor.id}`} value={`${actor.type}:${actor.id}`}>
                  {actor.type === 'admin' ? actor.label : `${actor.label} · ${ACTOR_TYPE_LABELS[actor.type]}`}
                </ComboboxOption>
              ))}
            </Combobox>
          </Field.Root>
        </Box>

        <Box minWidth="180px">
          <Field.Root name="category">
            <Field.Label>Area</Field.Label>
            <SingleSelect value={filters.category ?? ALL} onChange={select('category')}>
              <SingleSelectOption value={ALL}>Everything</SingleSelectOption>
              {(options?.categories ?? (Object.keys(CATEGORY_LABELS) as Array<keyof typeof CATEGORY_LABELS>)).map(
                (category) => (
                  <SingleSelectOption key={category} value={category}>
                    {CATEGORY_LABELS[category]}
                  </SingleSelectOption>
                )
              )}
            </SingleSelect>
          </Field.Root>
        </Box>

        <Box minWidth="200px">
          <Field.Root name="contentType">
            <Field.Label>Content type</Field.Label>
            <SingleSelect value={filters.contentType ?? ALL} onChange={select('contentType')} disabled={!options}>
              <SingleSelectOption value={ALL}>Any</SingleSelectOption>
              {(options?.contentTypes ?? []).map((type) => (
                <SingleSelectOption key={type.uid} value={type.uid}>
                  {type.label}
                </SingleSelectOption>
              ))}
            </SingleSelect>
          </Field.Root>
        </Box>

        <Box minWidth="140px">
          <Field.Root name="outcome">
            <Field.Label>Result</Field.Label>
            <SingleSelect value={filters.outcome ?? ALL} onChange={select('outcome')}>
              <SingleSelectOption value={ALL}>Any</SingleSelectOption>
              <SingleSelectOption value="success">Succeeded</SingleSelectOption>
              <SingleSelectOption value="failure">Failed</SingleSelectOption>
            </SingleSelect>
          </Field.Root>
        </Box>

        <Box flex="1" minWidth="220px">
          <Field.Root name="q">
            <Field.Label>Search</Field.Label>
            <TextInput
              value={search}
              maxLength={100}
              placeholder="Email, entry title, id or IP"
              startAction={<Search />}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
              onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter') onChange({ q: search || undefined });
              }}
            />
          </Field.Root>
        </Box>

        {activeCount > 0 && (
          <Button variant="tertiary" startIcon={<Cross />} onClick={onReset}>
            {`Clear ${activeCount} filter${activeCount === 1 ? '' : 's'}`}
          </Button>
        )}
      </Flex>
    </Box>
  );
};
