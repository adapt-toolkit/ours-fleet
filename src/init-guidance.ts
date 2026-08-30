export const INIT_COMPLETION_GUIDANCE = `
Next:
  cp "$(npm root -g)/@ours.network/fleet/examples/fleet.yaml" ~/fleet.yaml
  cp -R "$(npm root -g)/@ours.network/fleet/examples/fleet" ~/fleet
  edit ~/fleet.yaml and ~/fleet/{agents,roles,brains}/*.yaml, then: ours-fleet up`;
