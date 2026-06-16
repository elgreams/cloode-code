import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select, type OptionWithDescription } from '../../components/CustomSelect/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getDefaultHaikuModel, modelDisplayString } from '../../utils/model/model.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'

const DEFAULT_SMALL_FAST_MODEL = '__DEFAULT_SMALL_FAST_MODEL__'

type SmallFastModelPickerValue = string

function envOverride(): string | undefined {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || undefined
}

function smallFastModelLabel(): string {
  const env = envOverride()
  if (env) return `env ANTHROPIC_SMALL_FAST_MODEL (${env})`
  const model = getGlobalConfig().smallFastModel
  return model ? `override (${model})` : `default Haiku (${getDefaultHaikuModel()})`
}

function SmallFastModelPicker({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: 'system' | 'skip' }) => void
}): React.ReactNode {
  const current = getGlobalConfig().smallFastModel
  const defaultModel = getDefaultHaikuModel()
  const options: OptionWithDescription<SmallFastModelPickerValue>[] = [
    {
      value: DEFAULT_SMALL_FAST_MODEL,
      label: 'Default Haiku',
      description: defaultModel,
    },
    ...getModelOptions(false)
      .filter(option => option.value !== null)
      .map(option => ({
        value: option.value as string,
        label: option.label,
        description: option.description,
      })),
  ]
  const defaultValue = current ?? DEFAULT_SMALL_FAST_MODEL
  const defaultFocusValue = options.some(option => option.value === defaultValue)
    ? defaultValue
    : DEFAULT_SMALL_FAST_MODEL

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      Box,
      { marginBottom: 1, flexDirection: 'column' },
      React.createElement(
        Text,
        { color: 'remember', bold: true },
        'Select small/fast model',
      ),
      React.createElement(
        Text,
        { dimColor: true },
        'Used for cheap background calls (titles, summaries, web-fetch). Main chat model is unchanged.',
      ),
    ),
    React.createElement(Select<SmallFastModelPickerValue>, {
      defaultValue,
      defaultFocusValue,
      options,
      visibleOptionCount: Math.min(10, options.length),
      onCancel: () => {
        onDone(`Kept small/fast model as ${smallFastModelLabel()}`, {
          display: 'system',
        })
      },
      onChange: value => {
        if (value === DEFAULT_SMALL_FAST_MODEL) {
          saveGlobalConfig(c => ({ ...c, smallFastModel: undefined }))
          onDone(`Small/fast model reset to default Haiku (${defaultModel}).`)
          return
        }
        saveGlobalConfig(c => ({ ...c, smallFastModel: value }))
        onDone(
          `Small/fast model set to ${modelDisplayString(value)}. Main chat model unchanged.`,
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
  const restStr = trimmed.slice(sub.length).trim()

  if (!sub || sub === 'status' || sub === 'current') {
    return say(
      `Current small/fast model: **${smallFastModelLabel()}**\n\nUse \`/smallfastmodel model\` to choose a model, or \`/smallfastmodel default\` to reset.`,
    )
  }

  if (sub === 'model') {
    if (!restStr) {
      return React.createElement(SmallFastModelPicker, { onDone })
    }
    if (restStr.toLowerCase() === 'default' || restStr.toLowerCase() === 'reset') {
      saveGlobalConfig(c => ({ ...c, smallFastModel: undefined }))
      return say(
        `Small/fast model reset to **default Haiku (${getDefaultHaikuModel()})**.`,
      )
    }
    saveGlobalConfig(c => ({ ...c, smallFastModel: restStr }))
    return say(`Small/fast model set to **${restStr}**. Main chat model unchanged.`)
  }

  if (sub === 'default' || sub === 'reset') {
    saveGlobalConfig(c => ({ ...c, smallFastModel: undefined }))
    return say(
      `Small/fast model reset to **default Haiku (${getDefaultHaikuModel()})**.`,
    )
  }

  return say('Usage: `/smallfastmodel [model|default]`')
}
