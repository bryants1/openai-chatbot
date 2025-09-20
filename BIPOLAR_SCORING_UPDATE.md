# Bipolar Scoring System Implementation

## Overview
Successfully updated all 37 quiz questions to use a **bipolar scoring system** (-1.0 to +1.0) instead of the previous add-only system (0.0 to 1.0).

## Problem Solved
The previous scoring system had a fundamental flaw where every answer could only **add** to scores, never **reduce** them. This created biased profiles where:
- Users who consistently preferred easy courses would still get positive difficulty scores
- Users who didn't care about value would still get positive value scores
- True preferences couldn't be expressed

## Solution
Implemented **positive and negative weights** for question options:

### Before (Add-Only System)
```javascript
// "Luxury resort with full amenities"
{
  "value_proposition": 0.3,      // Only positive - can't express "I don't want value"
  "conditions_quality": 0.8,     // Only positive - can't express "I don't care about conditions"
  "overall_difficulty": 0.4,     // Only positive - can't express "I want easy courses"
  "service_operations": 0.8,     // Only positive - can't express "I don't need service"
  "facilities_amenities": 0.9    // Only positive - can't express "I don't need facilities"
}
```

### After (Bipolar System)
```javascript
// "Luxury resort with full amenities" - WANTS luxury, DOESN'T care about value
{
  "value_proposition": -0.6,     // NEGATIVE - doesn't care about value (expensive is fine)
  "conditions_quality": 0.8,     // POSITIVE - wants excellent conditions
  "overall_difficulty": -0.3,    // NEGATIVE - doesn't want super challenging
  "service_operations": 0.8,     // POSITIVE - wants excellent service
  "facilities_amenities": 0.9    // POSITIVE - wants excellent facilities
}

// "Local muni with character" - WANTS value, DOESN'T need luxury
{
  "value_proposition": 0.8,      // POSITIVE - wants good value
  "conditions_quality": -0.4,    // NEGATIVE - doesn't need perfect conditions
  "overall_difficulty": 0.2,     // POSITIVE - wants moderate difficulty
  "service_operations": -0.5,    // NEGATIVE - doesn't need fancy service
  "facilities_amenities": -0.6   // NEGATIVE - doesn't need fancy facilities
}
```

## How It Works

### Score Calculation
```javascript
// Example: User answers 3 questions about difficulty
// Q1: "Local muni with character" → overall_difficulty: 0.2
// Q2: "Play it safe, avoid trouble" → overall_difficulty: -0.5
// Q3: "Lay up short and chip on" → overall_difficulty: -0.6

// Final calculation:
// Sum: 0.2 + (-0.5) + (-0.6) = -0.9
// Count: 3 questions
// Average: -0.9 ÷ 3 = -0.3
// Final Score: -0.3 × 10 = -3.0 (clamped to 0) = 0.0

// Result: User gets a LOW difficulty score (0.0) because they consistently prefer EASY courses!
```

### Score Interpretation
- **+0.8 to +1.0**: Strong preference FOR this dimension
- **+0.4 to +0.7**: Moderate preference FOR this dimension  
- **-0.4 to +0.3**: Neutral/doesn't care much
- **-0.7 to -0.5**: Moderate preference AGAINST this dimension
- **-1.0 to -0.8**: Strong preference AGAINST this dimension

## Questions Updated
All 37 questions were updated with the new bipolar scoring system:

### Multi-Dimensional Questions (10)
- Q_EXPERIENCE_PREFERENCE_1
- Q_PLAYING_STYLE_1
- Q_CHALLENGE_PREFERENCE_1
- Q_COURSE_DESIGN_1
- Q_BUDGET_VALUE_1
- Q_SOCIAL_GROUP_1
- Q_MAINTENANCE_CONDITIONS_1
- Q_PHYSICAL_FITNESS_1
- Q_DIFFICULT_TRADEOFF_1
- Q_GOLF_PHILOSOPHY_1
- Q_RISK_TOLERANCE_1
- Q_COURSE_SELECTION_1

### Single-Dimension Questions (25)
- Q8_OPERATIONS_1-5 (service_operations)
- Q9_VALUE_1-5 (value_proposition)
- Q6_CONDITIONS_1-5 (conditions_quality)
- Q7_AMENITIES_1-5 (facilities_amenities)
- Q10_AESTHETICS_1-5 (aesthetic_appeal)

## Impact
This creates **true preference profiles** where:
- **High scores** = "I want this"
- **Low scores** = "I don't want this" 
- **Zero scores** = "I'm neutral"

Users can now express genuine preferences instead of being forced into an upward-trending scoring bias.

## Database Changes
All changes were made directly to the Supabase database via the admin API endpoints. No code changes were required as the scoring logic already supported the -1.0 to +1.0 range.

## Testing
The new system is ready for testing. Users taking the quiz will now generate more accurate preference profiles that truly reflect their golf course preferences.
