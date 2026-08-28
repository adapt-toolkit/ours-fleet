import{describe,expect,it}from'vitest';import{createProductionTempAgentSupervisorRehydration}from'../src/temp-agent-supervisor-rehydration.js';
describe('temporary supervisor rehydration',()=>{it('constructs without creating state and exposes no effect methods',()=>{const root=createProductionTempAgentSupervisorRehydration('/definitely/missing/temp-root');
  expect(Object.keys(root)).toEqual(['rehydrate']);expect(()=>root.rehydrate('a')).toThrow();});});
