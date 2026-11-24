import { useState } from "react";

const initialProfile = {
  name: "Ada",
  address: { city: "London" },
};

/**
 * `useState` with a `mut:` block in the updater: `p` is the latest state, and
 * the block turns the writes into a new object.
 *
 * Comment out `mut:` and typing does nothing: the updater then mutates `p` in
 * place and returns the same object, so React sees no change.
 */
export function Profile() {
  const [profile, setProfile] = useState(initialProfile);

  return (
    <section>
      <h2>Profile</h2>
      <input
        value={profile.name}
        onChange={(event) => {
          const name = event.target.value;
          setProfile((p) => {
            mut: {
              p.name = name;
            }
            return p;
          });
        }}
      />
      <input
        value={profile.address.city}
        onChange={(event) => {
          const city = event.target.value;
          setProfile((p) => {
            mut: {
              p.address.city = city;
            }
            return p;
          });
        }}
      />
      <p>
        {profile.name} lives in {profile.address.city}.
      </p>
    </section>
  );
}
