import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinates, currencyRateInput, donationIntentInput, foodDonationInput, mealRequestInput, mealTypeUpdateInput } from '../src/schemas.js';

test('coordinates reject impossible GPS values', () => {
  assert.equal(coordinates.safeParse({ latitude: 91, longitude: 0 }).success, false);
  assert.equal(coordinates.safeParse({ latitude: 30.1, longitude: 31.2 }).success, true);
});

test('meal request validates bounded quantity', () => {
  assert.equal(mealRequestInput.safeParse({ latitude: 30, longitude: 31, meals: 0, timing: 'now' }).success, false);
  assert.equal(mealRequestInput.safeParse({ latitude: 30, longitude: 31, meals: 2, timing: 'now' }).success, true);
});

test('food donation rejects expired offers and invalid windows', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(foodDonationInput.safeParse({ latitude: 30, longitude: 31, food_name: 'Rice', meals: 1, pickup_start: past, pickup_end: past, expires_at: past }).success, false);
});

test('admin pricing inputs are bounded and reject unknown fields', () => {
  assert.equal(mealTypeUpdateInput.safeParse({ price_usd: 5, unexpected: true }).success, false);
  assert.equal(mealTypeUpdateInput.safeParse({ price_usd: 5, is_active: true }).success, true);
  assert.equal(currencyRateInput.safeParse({ rate: 0 }).success, false);
});

test('donation targets require an explicit valid destination', () => {
  const mealTypeId = '00000000-0000-0000-0000-000000000001';
  const charityId = '00000000-0000-0000-0000-000000000002';
  assert.equal(donationIntentInput.safeParse({ meal_type_id: mealTypeId, meal_count: 1, currency: 'USD', target_type: 'charity' }).success, false);
  assert.equal(donationIntentInput.safeParse({ meal_type_id: mealTypeId, meal_count: 1, currency: 'USD', target_type: 'charity', target_charity_id: charityId }).success, true);
  assert.equal(donationIntentInput.safeParse({ meal_type_id: mealTypeId, meal_count: 1, currency: 'USD', target_type: 'general', target_charity_id: charityId }).success, false);
});
