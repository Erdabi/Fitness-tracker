import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { Button, Card, Screen, Text, TextField } from '@/components/ui';
import type { ActivityLevelValue } from '@/db/schema';
import { EstimateNotice, FloorNotice, BelowFloorWarning } from '@/features/goals/EstimateNotice';
import {
  calculateRecommendation,
  useCalculatorSeed,
  useGoalMutations,
} from '@/features/goals/useGoals';
import { useProfile } from '@/features/profile/useProfile';
import {
  validateAge,
  validateCalorieTarget,
  validateHeight,
  validateWeight,
} from '@/lib/bodyInputs';
import { todayIn } from '@/lib/date';
import {
  ACTIVITY_LEVELS,
  activityDefinition,
  calorieFloorFor,
  macroTargets,
  type BiologicalSex,
  type BodyMetrics,
  type GoalDirection,
} from '@/lib/energy';
import { cmToFeetInches, kgToLb, round } from '@/lib/units';
import { useTheme } from '@/theme';

/**
 * The calculator.
 *
 * Five steps, in the order the questions depend on each other: who you are,
 * how active you are, what you want, what that gives, and what you actually
 * want to use. The last two are separate on purpose — the results screen shows
 * the app's recommendation, and the confirm step is where it becomes a target,
 * accepted or adjusted. Collapsing them would make it impossible to tell those
 * two things apart afterwards.
 */

type Step = 'basics' | 'activity' | 'goal' | 'results' | 'confirm';
const STEPS: Step[] = ['basics', 'activity', 'goal', 'results', 'confirm'];

export default function CalculatorScreen() {
  const theme = useTheme();
  const router = useRouter();
  const seed = useCalculatorSeed();
  const { profile } = useProfile();
  const { applyCalculation } = useGoalMutations();

  const [step, setStep] = useState<Step>('basics');
  const system = seed.unitSystem;

  // Prefilled from the profile and the latest weigh-in, in whichever units the
  // user reads. Only the canonical value is ever stored.
  const [age, setAge] = useState(seed.ageYears ? String(seed.ageYears) : '');
  const [sex, setSex] = useState<BiologicalSex>(seed.sex);
  const [heightCm, setHeightCm] = useState(
    seed.heightCm && system === 'metric' ? String(round(seed.heightCm)) : '',
  );
  const [feet, setFeet] = useState(
    seed.heightCm && system === 'imperial' ? String(cmToFeetInches(seed.heightCm).feet) : '',
  );
  const [inches, setInches] = useState(
    seed.heightCm && system === 'imperial'
      ? String(cmToFeetInches(seed.heightCm).inches)
      : '',
  );
  const [weight, setWeight] = useState(
    seed.weightKg
      ? String(round(system === 'metric' ? seed.weightKg : kgToLb(seed.weightKg), 1))
      : '',
  );
  const [activity, setActivity] = useState<ActivityLevelValue | null>(seed.activity);
  const [direction, setDirection] = useState<GoalDirection>('lose');

  const [customTarget, setCustomTarget] = useState('');
  const [isCustomising, setIsCustomising] = useState(false);

  const ageResult = validateAge(age);
  const weightResult = validateWeight(weight, system);
  const heightResult = validateHeight({ cm: heightCm, feet, inches }, system);

  // Reduced to scalars first, so the memo below compares numbers rather than
  // a fresh result object built on every keystroke.
  const ageYears = ageResult.ok ? ageResult.value : null;
  const weightKg = weightResult.ok ? weightResult.value : null;
  const validHeightCm = heightResult.ok ? heightResult.value : null;

  const metrics = useMemo<BodyMetrics | null>(
    () =>
      ageYears !== null && weightKg !== null && validHeightCm !== null && sex !== 'unspecified'
        ? { ageYears, weightKg, heightCm: validHeightCm, sex }
        : null,
    [ageYears, weightKg, validHeightCm, sex],
  );

  const calculated = useMemo(
    () =>
      metrics && activity
        ? calculateRecommendation({ metrics, activity, direction })
        : null,
    [metrics, activity, direction],
  );

  const customResult = validateCalorieTarget(customTarget);
  const floor = metrics
    ? calorieFloorFor(metrics.sex, calculated?.bmr ?? null)
    : calorieFloorFor('unspecified', null);
  const customIsBelowFloor = customResult.ok && customResult.value < floor;

  function goNext(): void {
    const index = STEPS.indexOf(step);
    if (index < STEPS.length - 1) setStep(STEPS[index + 1]!);
  }

  function goBack(): void {
    const index = STEPS.indexOf(step);
    if (index > 0) setStep(STEPS[index - 1]!);
    else router.back();
  }

  function confirm(chosenCalories?: number): void {
    if (!metrics || !activity || !calculated) return;

    const chosen =
      chosenCalories === undefined
        ? undefined
        : {
            calorieTarget: chosenCalories,
            macros: macroTargets(chosenCalories, metrics.weightKg, direction),
          };

    applyCalculation({
      effectiveFrom: todayIn(profile?.time_zone ?? 'UTC'),
      calculated,
      chosen,
      input: { metrics, activity, direction },
      acknowledgedBelowFloor: chosenCalories !== undefined && chosenCalories < floor,
    });

    router.replace('/goals');
  }

  return (
    <Screen scrollable keyboardAvoiding>
      <StepIndicator step={step} />

      {step === 'basics' ? (
        <View style={{ gap: theme.spacing.lg }}>
          <Text variant="displayMedium">About you</Text>

          <TextField
            label="Age"
            value={age}
            onChangeText={setAge}
            keyboardType="number-pad"
            hint="In years"
            error={age.length > 0 && !ageResult.ok ? ageResult.errors[0]!.message : undefined}
          />

          <SexPicker value={sex} onChange={setSex} />

          {system === 'metric' ? (
            <TextField
              label="Height"
              value={heightCm}
              onChangeText={setHeightCm}
              keyboardType="decimal-pad"
              hint="cm"
              error={
                heightCm.length > 0 && !heightResult.ok
                  ? heightResult.errors[0]!.message
                  : undefined
              }
            />
          ) : (
            <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
              <View style={{ flex: 1 }}>
                <TextField
                  label="Height"
                  value={feet}
                  onChangeText={setFeet}
                  keyboardType="number-pad"
                  hint="feet"
                />
              </View>
              <View style={{ flex: 1 }}>
                <TextField
                  label=" "
                  value={inches}
                  onChangeText={setInches}
                  keyboardType="number-pad"
                  hint="inches"
                  error={
                    (feet.length > 0 || inches.length > 0) && !heightResult.ok
                      ? heightResult.errors[0]!.message
                      : undefined
                  }
                />
              </View>
            </View>
          )}

          <TextField
            label="Weight"
            value={weight}
            onChangeText={setWeight}
            keyboardType="decimal-pad"
            hint={system === 'metric' ? 'kg' : 'lb'}
            error={
              weight.length > 0 && !weightResult.ok
                ? weightResult.errors[0]!.message
                : undefined
            }
          />

          {sex === 'unspecified' ? (
            <Text variant="caption" color="secondary">
              The formula this uses has separate terms for male and female bodies and no
              term for anything else, so it cannot run without one. You can skip the
              calculator and set a target by hand instead.
            </Text>
          ) : null}

          <Button label="Continue" disabled={metrics === null} onPress={goNext} />
          {sex === 'unspecified' ? (
            <Button
              label="Set a target by hand"
              variant="secondary"
              onPress={() => router.replace('/goals')}
            />
          ) : null}
        </View>
      ) : null}

      {step === 'activity' ? (
        <View style={{ gap: theme.spacing.lg }}>
          <Text variant="displayMedium">How active are you?</Text>
          <Text variant="callout" color="secondary">
            Count everything, not just deliberate exercise — a job on your feet moves
            this more than three gym sessions do.
          </Text>

          <View style={{ gap: theme.spacing.sm }}>
            {ACTIVITY_LEVELS.map((definition) => {
              const selected = activity === definition.level;
              return (
                <Pressable
                  key={definition.level}
                  onPress={() => setActivity(definition.level)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${definition.label}. ${definition.description}`}
                  style={{
                    padding: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    borderWidth: selected ? 2 : 1,
                    borderColor: selected ? theme.colors.accent : theme.colors.border,
                    backgroundColor: selected
                      ? theme.colors.accentMuted
                      : theme.colors.surface,
                    gap: 2,
                  }}
                >
                  <Text variant="bodyStrong" color={selected ? 'accent' : 'primary'}>
                    {definition.label}
                  </Text>
                  {/* The description is the only way to pick well between these. */}
                  <Text variant="caption" color="secondary">
                    {definition.description}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Button label="Continue" disabled={activity === null} onPress={goNext} />
          <Button label="Back" variant="ghost" onPress={goBack} />
        </View>
      ) : null}

      {step === 'goal' ? (
        <View style={{ gap: theme.spacing.lg }}>
          <Text variant="displayMedium">What are you aiming for?</Text>

          <View style={{ gap: theme.spacing.sm }}>
            {(
              [
                ['lose', 'Lose weight', 'A moderate deficit — about 0.45 kg a week.'],
                ['maintain', 'Maintain weight', 'Eat around what you burn.'],
                ['gain', 'Gain weight', 'A small surplus, to keep more of it lean.'],
              ] as [GoalDirection, string, string][]
            ).map(([value, label, description]) => {
              const selected = direction === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => setDirection(value)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${label}. ${description}`}
                  style={{
                    padding: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    borderWidth: selected ? 2 : 1,
                    borderColor: selected ? theme.colors.accent : theme.colors.border,
                    backgroundColor: selected
                      ? theme.colors.accentMuted
                      : theme.colors.surface,
                    gap: 2,
                  }}
                >
                  <Text variant="bodyStrong" color={selected ? 'accent' : 'primary'}>
                    {label}
                  </Text>
                  <Text variant="caption" color="secondary">
                    {description}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Button label="See the numbers" onPress={goNext} />
          <Button label="Back" variant="ghost" onPress={goBack} />
        </View>
      ) : null}

      {step === 'results' && calculated && metrics && activity ? (
        <View style={{ gap: theme.spacing.lg }}>
          <Text variant="displayMedium">Your estimate</Text>

          <Card>
            <Row
              label="Resting metabolic rate"
              value={`${Math.round(calculated.bmr).toLocaleString()} kcal`}
              note="What your body uses at complete rest."
            />
            <Row
              label="Estimated maintenance"
              value={`${Math.round(calculated.tdee).toLocaleString()} kcal`}
              note={`Resting rate × ${activityDefinition(activity).multiplier} for ${activityDefinition(
                activity,
              ).label.toLowerCase()}.`}
            />
            <Row
              label="Suggested target"
              value={`${calculated.calorieTarget.toLocaleString()} kcal`}
              note={
                calculated.appliedAdjustment === 0
                  ? 'The same as maintenance.'
                  : `${calculated.appliedAdjustment > 0 ? '+' : ''}${calculated.appliedAdjustment.toLocaleString()} kcal a day.`
              }
              emphasis
            />
          </Card>

          {calculated.floorApplied ? (
            <FloorNotice floor={calculated.floor} rawTarget={calculated.rawTarget} />
          ) : null}

          <Card>
            <Text variant="overline" color="secondary">
              Suggested macros
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <MacroBlock label="Protein" grams={calculated.macros.protein_g} />
              <MacroBlock label="Carbs" grams={calculated.macros.carbohydrates_g} />
              <MacroBlock label="Fat" grams={calculated.macros.fat_g} />
            </View>
            <Text variant="caption" color="muted">
              Protein from your body weight, fat as a share of the target, carbohydrate
              from what is left. All recommendations.
            </Text>
          </Card>

          <EstimateNotice />

          <Button label="Continue" onPress={goNext} />
          <Button label="Back" variant="ghost" onPress={goBack} />
        </View>
      ) : null}

      {step === 'confirm' && calculated ? (
        <View style={{ gap: theme.spacing.lg }}>
          <Text variant="displayMedium">Set your target</Text>

          <Card>
            <Row
              label="Estimated maintenance"
              value={`${Math.round(calculated.tdee).toLocaleString()} kcal`}
            />
            <Row
              label="Suggested goal"
              value={`${calculated.calorieTarget.toLocaleString()} kcal`}
              emphasis
            />
          </Card>

          {isCustomising ? (
            <View style={{ gap: theme.spacing.md }}>
              <TextField
                label="Your target"
                value={customTarget}
                onChangeText={setCustomTarget}
                keyboardType="number-pad"
                hint="kcal per day"
                error={
                  customTarget.length > 0 && !customResult.ok
                    ? customResult.errors[0]!.message
                    : undefined
                }
              />

              {customIsBelowFloor ? <BelowFloorWarning floor={floor} /> : null}

              <Text variant="caption" color="muted">
                The suggested {calculated.calorieTarget.toLocaleString()} kcal is kept
                alongside whatever you choose, so you can always see what was
                recommended.
              </Text>

              <Button
                label="Use my target"
                disabled={!customResult.ok}
                onPress={() => customResult.ok && confirm(customResult.value)}
              />
              <Button
                label="Use the suggestion instead"
                variant="secondary"
                onPress={() => setIsCustomising(false)}
              />
            </View>
          ) : (
            <View style={{ gap: theme.spacing.md }}>
              <Button label="Accept the recommendation" onPress={() => confirm()} />
              <Button
                label="Choose my own target"
                variant="secondary"
                onPress={() => {
                  setCustomTarget(String(calculated.calorieTarget));
                  setIsCustomising(true);
                }}
              />
            </View>
          )}

          <Button label="Back" variant="ghost" onPress={goBack} />
        </View>
      ) : null}
    </Screen>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const theme = useTheme();
  const index = STEPS.indexOf(step);

  return (
    <View
      style={{ flexDirection: 'row', gap: 6, paddingVertical: theme.spacing.lg }}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 1, max: STEPS.length, now: index + 1 }}
      accessibilityLabel={`Step ${index + 1} of ${STEPS.length}`}
    >
      {STEPS.map((name, position) => (
        <View
          key={name}
          style={{
            flex: 1,
            height: 3,
            borderRadius: 2,
            backgroundColor:
              position <= index ? theme.colors.accent : theme.colors.surfaceMuted,
          }}
        />
      ))}
    </View>
  );
}

function SexPicker({
  value,
  onChange,
}: {
  value: BiologicalSex;
  onChange: (value: BiologicalSex) => void;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="overline" color="secondary">
        Sex
      </Text>
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
        {(
          [
            ['female', 'Female'],
            ['male', 'Male'],
          ] as [BiologicalSex, string][]
        ).map(([option, label]) => {
          const selected = value === option;
          return (
            <Pressable
              key={option}
              onPress={() => onChange(option)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={label}
              style={{
                flex: 1,
                alignItems: 'center',
                paddingVertical: theme.spacing.md,
                borderRadius: theme.radius.md,
                borderWidth: selected ? 2 : 1,
                borderColor: selected ? theme.colors.accent : theme.colors.border,
                backgroundColor: selected ? theme.colors.accentMuted : 'transparent',
              }}
            >
              <Text variant="body" color={selected ? 'accent' : 'primary'}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text variant="caption" color="muted">
        Used only for the equation, which has separate terms for each.
      </Text>
    </View>
  );
}

function Row({
  label,
  value,
  note,
  emphasis = false,
}: {
  label: string;
  value: string;
  note?: string;
  emphasis?: boolean;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant={emphasis ? 'bodyStrong' : 'body'} color={emphasis ? 'primary' : 'secondary'}>
          {label}
        </Text>
        <Text variant={emphasis ? 'title' : 'body'} tabular>
          {value}
        </Text>
      </View>
      {note ? (
        <Text variant="caption" color="muted" style={{ paddingRight: theme.spacing.xl }}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

function MacroBlock({ label, grams }: { label: string; grams: number }) {
  return (
    <View>
      <Text variant="title" tabular>
        {grams} g
      </Text>
      <Text variant="overline" color="muted">
        {label}
      </Text>
    </View>
  );
}
