// Test widget that throws in create().
export default {
  description: 'Always fails.',
  props: {},
  create() {
    throw new Error('broken on purpose');
  },
};
