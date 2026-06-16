import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select, type OptionWithDescription } from '../../components/CustomSelect/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { modelDisplayString } from '../../utils/model/model.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'

const OFF_VALUE = '__LOW_USAGE_OFF__'

type LowUsageModelPickerValue = string

function lowUsageStatusLabel(): string {
  const model = getGlobalConfig().auxModel
  return model ? `on — background work → ${model}` : 'off'
}

function LowUsageModelPicker({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: 'system' | 'skip' }) => void
}): React.ReactNode {
  const current = getGlobalConfig().auxModel
  const options: OptionWithDescription<LowUsageModelPickerValue>[] = [
    {
      value: OFF_VALUE,
      label: 'Off',
      description: 'Use the main model everywhere (default)',
    },
    ...getModelOptions(false)
      .filter(option => option.value !== null)
      .map(option => ({
        value: option.value as string,
        label: option.label,
        description: option.description,
      })),
  ]
  const defaultValue = current ?? OFF_VALUE
  const defaultFocusValue = options.some(option => option.value === defaultValue)
    ? defaultValue
    : OFF_VALUE

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      Box,
      { marginBottom: 1, flexDirection: 'column' },
      React.createElement(
        Text,
        { color: 'remember', bold: true },
        'Select low-usage background model',
      ),
      React.createElement(
        Text,
        { dimColor: true },
        'Routes subagents and permission checks to this cheaper model. Your main chat model is unchanged.',
      ),
    ),
    React.createElement(Select<LowUsageModelPickerValue>, {
      defaultValue,
      defaultFocusValue,
      options,
      visibleOptionCount: Math.min(10, options.length),
      onCancel: () => {
        onDone(`Kept low-usage mode ${lowUsageStatusLabel()}`, {
          display: 'system',
        })
      },
      onChange: value => {
        if (value === OFF_VALUE) {
          saveGlobalConfig(c => ({ ...c, auxModel: undefined }))
          onDone('Low-usage mode turned off. All work uses the main model.')
          return
        }
        saveGlobalConfig(c => ({ ...c, auxModel: value }))
        onDone(
          `Low-usage mode on. Background work routed to ${modelDisplayString(value)}. Main chat model unchanged.`,
        )
      },
    }),
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const say = (message: string): null => {
    onDone(message, { display: 'system' })
    return null
  }

  const trimmed = (args ?? '').trim()
  const sub = (trimmed.split(/\s+/)[0] ?? '').toLowerCase()

  if (!sub || sub === 'status' || sub === 'current') {
    return say(
      `Low-usage mode: **${lowUsageStatusLabel()}**\n\nUse \`/lowusage model\` to choose a cheaper background model, or \`/lowusage off\` to disable.`,
    )
  }

  if (sub === 'off' || sub === 'default' || sub === 'reset') {
    saveGlobalConfig(c => ({ ...c, auxModel: undefined }))
    return say('Low-usage mode turned **off**. All work uses the main model.')
  }

  if (sub === 'model') {
    return React.createElement(LowUsageModelPicker, { onDone })
  }

  return say('Usage: `/lowusage [model|off|status]`')
}
