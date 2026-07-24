import { Redirect } from 'expo-router';

// The bare `/` entry: send the user to the default authed route. The (app) guard
// bounces to /login (preserving `next`) when the sync snapshot is unauthenticated,
// so this single redirect covers both the logged-in and logged-out cold starts.
export default function Index() {
  return <Redirect href="/transactions" />;
}
